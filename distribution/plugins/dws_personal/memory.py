"""Host-side read-only gbrain context provider for routed Hermes sessions."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional


def _file(value: Optional[str], label: str) -> str:
    path = Path(str(value or "").strip()).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise RuntimeError(f"{label} must be an absolute regular file")
    return str(path.resolve())


class NodeProjectMemoryProvider:
    def __init__(
        self,
        *,
        node_path: str,
        sidecar_path: str,
        config_path: str,
        timeout: float = 30.0,
    ) -> None:
        self.node_path = _file(node_path, "Node executable")
        if not os.access(self.node_path, os.X_OK):
            raise RuntimeError("Node executable is not executable")
        self.sidecar_path = _file(sidecar_path, "personal memory sidecar")
        self.config_path = _file(config_path, "Foursday production config")
        self.timeout = timeout

    @classmethod
    def from_environment(cls) -> "NodeProjectMemoryProvider":
        return cls(
            node_path=os.getenv("FOURSDAY_NODE_PATH") or "/opt/homebrew/bin/node",
            sidecar_path=os.getenv("FOURSDAY_MEMORY_CONTEXT_SIDECAR", ""),
            config_path=os.getenv("FOURSDAY_PRODUCTION_CONFIG", ""),
        )

    async def context_for_route(self, route) -> str:
        project = getattr(route, "project", None)
        slugs = list(getattr(project, "gbrain_slugs", ()) or ())
        for related in list(getattr(route, "related_projects", ()) or ())[:8]:
            slugs.extend(list(getattr(related, "gbrain_slugs", ()) or ()))
        slugs.extend(list(getattr(route, "related_gbrain_slugs", ()) or ())[:12])
        slugs = list(dict.fromkeys(slugs))[:32]
        if not project or not slugs:
            return ""
        memory_home = str(
            os.getenv("FOURSDAY_MEMORY_HOME") or os.getenv("HOME") or ""
        ).strip()
        if not os.path.isabs(memory_home) or not os.path.isdir(memory_home):
            raise RuntimeError("Personal memory host home must be an absolute directory")
        process = await asyncio.create_subprocess_exec(
            self.node_path,
            self.sidecar_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={
                "HOME": memory_home,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            },
        )
        request = json.dumps({
            "configPath": self.config_path,
            "slugs": slugs,
            "maxTotalBytes": 24 * 1024,
        }, ensure_ascii=False).encode() + b"\n"
        try:
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(request),
                timeout=self.timeout,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError("Personal memory context timed out")
        if process.returncode != 0:
            raise RuntimeError("Personal memory context sidecar failed")
        frames = [line for line in stdout.decode("utf-8").splitlines() if line.strip()]
        if len(frames) != 1:
            raise RuntimeError("Personal memory context sidecar returned an invalid frame")
        response = json.loads(frames[0])
        context = response.get("result", {}).get("context") if response.get("success") else ""
        return str(context or "")


__all__ = ["NodeProjectMemoryProvider"]
