"""JSON-lines bridge between Hermes' Python gateway and Foursday's DWS adapter."""

from __future__ import annotations

import asyncio
from collections import deque
import json
import logging
import os
from pathlib import Path
import re
from typing import Any, Awaitable, Callable, Optional


logger = logging.getLogger(__name__)
_SAFE_ERROR_CODE = re.compile(r"^dws_sidecar_check_failed:([A-Za-z0-9_.-]{1,80})$")
_SAFE_MANUAL_REPLY_ERROR = re.compile(
    r"^dws_sidecar_manual_reply_probe_failed:([A-Za-z0-9_.-]{1,80})$"
)
_SAFE_TARGET_ERROR = re.compile(
    r"^dws_sidecar_target_failed:(user|group|enterprise):(\d{1,3}):([a-f0-9]{16}):([A-Za-z0-9_.-]{1,80})$"
)


def _required_file(value: Optional[str], label: str) -> str:
    path = Path(str(value or "").strip()).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise RuntimeError(f"{label} must be an absolute regular file")
    return str(path.resolve())


class JsonLineDwsBridge:
    """Runs the Node DWS sidecar without exposing production secrets to Hermes tools."""

    def __init__(
        self,
        *,
        node_path: str,
        sidecar_path: str,
        environment: Optional[dict[str, str]] = None,
        startup_timeout: float = 120.0,
        request_timeout: float = 300.0,
    ) -> None:
        self.node_path = _required_file(node_path, "Node executable")
        if not os.access(self.node_path, os.X_OK):
            raise RuntimeError("Node executable is not executable")
        self.sidecar_path = _required_file(sidecar_path, "DWS sidecar")
        self.environment = dict(environment or {})
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self._process: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._callback: Optional[Callable[[dict], Awaitable[None]]] = None
        self._ready: Optional[asyncio.Future] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._counter = 0
        self._buffering_events = True
        self._event_buffer: list[dict] = []
        self._stderr_codes: deque[str] = deque(maxlen=20)
        self._logged_stderr_codes: set[str] = set()

    @classmethod
    def from_environment(cls) -> "JsonLineDwsBridge":
        node_path = os.getenv("FOURSDAY_NODE_PATH") or "/opt/homebrew/bin/node"
        sidecar_path = os.getenv("FOURSDAY_DWS_SIDECAR")
        allowed = {
            key: value
            for key, value in os.environ.items()
            if key in {
                "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ",
                "FOURSDAY_DWS_HOME",
                "DWS_PATH", "DINGTALK_ROOT", "DINGTALK_DATA_ROOT",
                "DINGTALK_SELF_USER_ID",
                "DWS_PERSONAL_ALLOWED_USERS", "DWS_PERSONAL_ALLOWED_GROUPS",
                "DWS_PERSONAL_FETCH_USERS",
                "DWS_PERSONAL_ENTERPRISE_USERS_ENABLED",
                "DWS_PERSONAL_STATE_FILE", "DWS_PERSONAL_FALLBACK_MS",
                "DWS_PERSONAL_COMMAND_LOCK",
                "DWS_PERSONAL_HISTORY_SETTLE_MS",
                "DWS_PERSONAL_EVENT_WAKE_ENABLED",
                "DWS_PERSONAL_OUTBOUND_QUIET_MS",
                "DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS",
                "DWS_PERSONAL_MEDIA_ROOT",
                "FOURSDAY_CONTROL_FILE",
                "DWS_PERSONAL_INITIAL_LOOKBACK_MS", "DWS_PERSONAL_SEND_ENABLED",
            }
        }
        dws_home = str(allowed.pop("FOURSDAY_DWS_HOME", "") or "").strip()
        if dws_home:
            if not os.path.isabs(dws_home) or not os.path.isdir(dws_home):
                raise RuntimeError("DWS host home must be an absolute directory")
            allowed["HOME"] = dws_home
        allowed["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        return cls(
            node_path=node_path,
            sidecar_path=str(sidecar_path or ""),
            environment=allowed,
        )

    async def start(self, callback: Callable[[dict], Awaitable[None]]) -> None:
        if self._process is not None:
            return
        self._callback = callback
        self._buffering_events = True
        self._event_buffer.clear()
        loop = asyncio.get_running_loop()
        self._ready = loop.create_future()
        self._process = await asyncio.create_subprocess_exec(
            self.node_path,
            self.sidecar_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.environment,
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        try:
            await asyncio.wait_for(self._ready, timeout=self.startup_timeout)
        except BaseException:
            await self.stop()
            raise

    async def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        while line := await self._process.stderr.readline():
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                matched = _SAFE_ERROR_CODE.fullmatch(text)
                manual_reply = _SAFE_MANUAL_REPLY_ERROR.fullmatch(text)
                target = _SAFE_TARGET_ERROR.fullmatch(text)
                code = (
                    matched.group(1)
                    if matched
                    else f"manual_reply_probe:{manual_reply.group(1)}"
                    if manual_reply
                    else f"target:{target.group(1)}:{target.group(2)}:{target.group(3)}:{target.group(4)}"
                    if target
                    else "sidecar_stderr"
                )
                self._stderr_codes.append(code)
                if code not in self._logged_stderr_codes:
                    if len(self._logged_stderr_codes) >= 50:
                        self._logged_stderr_codes.clear()
                    self._logged_stderr_codes.add(code)
                    logger.warning("DWS sidecar diagnostic: %s", code)

    async def _read_loop(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            while line := await self._process.stdout.readline():
                try:
                    frame = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if frame.get("type") == "ready":
                    if self._ready and not self._ready.done():
                        self._ready.set_result(True)
                    continue
                if frame.get("type") == "event" and isinstance(frame.get("record"), dict):
                    if self._buffering_events:
                        if len(self._event_buffer) >= 10_000:
                            raise RuntimeError("DWS startup event buffer exceeded its bound")
                        self._event_buffer.append(frame["record"])
                    elif self._callback is not None:
                        await self._callback(frame["record"])
                    continue
                if frame.get("type") == "response":
                    request_id = str(frame.get("id") or "")
                    future = self._pending.pop(request_id, None)
                    if future is not None and not future.done():
                        future.set_result(frame.get("result"))
        finally:
            error = RuntimeError("DWS sidecar stopped")
            if self._ready and not self._ready.done():
                self._ready.set_exception(error)
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()

    async def release_events(self) -> None:
        while self._event_buffer:
            records = self._event_buffer
            self._event_buffer = []
            if self._callback is not None:
                for record in records:
                    await self._callback(record)
        self._buffering_events = False

    async def _request(self, action: str, payload: Optional[dict] = None) -> Any:
        if self._process is None or self._process.stdin is None:
            raise RuntimeError("DWS sidecar is not running")
        self._counter += 1
        request_id = str(self._counter)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        frame = {
            "type": "request",
            "id": request_id,
            "action": action,
            "payload": dict(payload or {}),
        }
        self._process.stdin.write((json.dumps(frame, ensure_ascii=False) + "\n").encode())
        await self._process.stdin.drain()
        try:
            return await asyncio.wait_for(future, timeout=self.request_timeout)
        finally:
            self._pending.pop(request_id, None)

    async def send(self, payload: dict) -> dict:
        result = await self._request("send", payload)
        return result if isinstance(result, dict) else {"success": False}

    async def ack_control(self, task_id: str, event_id: str) -> dict:
        result = await self._request("ack-control", {
            "taskId": str(task_id),
            "eventId": str(event_id),
        })
        return result if isinstance(result, dict) else {"success": False}

    async def stop(self) -> None:
        process = self._process
        if process is None:
            return
        if process.returncode is None:
            try:
                await self._request("shutdown")
            except Exception:
                pass
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        if self._reader_task is not None:
            await asyncio.gather(self._reader_task, return_exceptions=True)
        if self._stderr_task is not None:
            await asyncio.gather(self._stderr_task, return_exceptions=True)
        self._process = None
        self._reader_task = None
        self._stderr_task = None
        self._buffering_events = True
        self._event_buffer.clear()


__all__ = ["JsonLineDwsBridge"]
