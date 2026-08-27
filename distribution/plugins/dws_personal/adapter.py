"""Hermes platform adapter for Foursday's normalized DWS bridge protocol."""

from __future__ import annotations

import asyncio
from collections import deque
import contextvars
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import tempfile
import threading
import time
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional
from types import SimpleNamespace

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)


def _strings(value: Any) -> set[str]:
    if isinstance(value, str):
        values: Iterable[Any] = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        values = []
    return {str(item).strip() for item in values if str(item).strip()}


def _milliseconds(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(default if value in (None, "") else value)
    except (TypeError, ValueError) as error:
        raise ValueError("DWS bundle timing is invalid") from error
    if parsed < minimum or parsed > maximum:
        raise ValueError("DWS bundle timing is invalid")
    return parsed


def dws_available() -> bool:
    configured = str(os.getenv("DWS_PATH", "")).strip()
    if configured:
        return os.path.isabs(configured) and os.access(configured, os.X_OK)
    return shutil.which("dws") is not None


_OUTBOUND_SECRET = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|bearer)\s*[:=]\s*\S+"
    r"|\b(?:ghp|github_pat|sk-[A-Za-z0-9_-]{10,}|AKIA)[A-Za-z0-9_-]+"
    r"|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s]+"
    r"|\bfctx_[a-f0-9]{64}\b",
    re.IGNORECASE,
)
_IRREVERSIBLE_COMMITMENT = re.compile(
    r"(?:我|我们|本人|Foursday).{0,12}(?:保证|承诺|同意|批准|决定).{0,24}(?:付款|转账|签署|合同|录用|辞退|调薪|绩效|赔偿|不可撤销)"
    r"|\b(?:I|we)\s+(?:guarantee|commit|approve|agree)\b.{0,40}\b(?:pay|transfer|sign|hire|fire|salary|contract|irrevocable)\b",
    re.IGNORECASE,
)
_INTERNAL_GATEWAY_NOTICE = re.compile(
    r"^(?:↪ Redirected current run|⚡ Interrupting current task"
    r"|⏳ (?:Queued for the next turn|Subagent working|Compressing context)"
    r"|⏩ Steered into current run)(?:\s|\(|[.—-])",
    re.IGNORECASE,
)
_FOURSDAY_CONTEXT_MARKER = re.compile(
    r"<!--\s*foursday-context:(fctx_[a-f0-9]{64})\s*-->",
    re.IGNORECASE,
)
_CURRENT_RUNTIME_STATUS = re.compile(
    r"(?:Foursday.{0,32}(?:当前|现在|最新|运行|版本|模式|状态|发送|send|active|shadow|ready)"
    r"|(?:当前|现在|最新|运行状态|版本|模式|真实发送).{0,32}Foursday)",
    re.IGNORECASE,
)
_FULL_RELEASE_SHA = re.compile(r"^[a-f0-9]{40}$")
_DINGTALK_DOCUMENT_LINK = re.compile(
    r"https://alidocs\.dingtalk\.com/i/nodes/([A-Za-z0-9]{20,80})(?:\?[A-Za-z0-9%&=._~-]{0,1000})?",
    re.IGNORECASE,
)


def _digest(value: Any) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:16]


def _provided_dingtalk_sources(
    text: Any,
    *,
    message_ids: list[str],
    requester_role: str,
) -> list[dict[str, str]]:
    if requester_role not in {"owner", "trusted"}:
        raise RuntimeError("Foursday requester role is invalid")
    message_hash = hashlib.sha256(
        "\x00".join(str(value) for value in message_ids).encode("utf-8")
    ).hexdigest()
    output = []
    seen = set()
    for match in _DINGTALK_DOCUMENT_LINK.finditer(str(text or "")):
        node_id = match.group(1)
        if node_id in seen:
            continue
        seen.add(node_id)
        output.append({
            "sourceId": f"provided_{len(output) + 1}",
            "kind": "doc",
            "nodeId": node_id,
            "messageHash": message_hash,
            "requesterRole": requester_role,
        })
        if len(output) >= 4:
            break
    return output


def _dingtalk_plain_text(value: Any) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"```[^\n]*\n?", "", text)
    text = text.replace("```", "")
    text = re.sub(r"`([^`\n]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_\n]+)__", r"\1", text)
    text = re.sub(r"~~([^~\n]+)~~", r"\1", text)
    text = re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+", "", text)
    text = re.sub(r"(?m)^[ \t]*[-*+][ \t]+", "• ", text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def _private_runtime_json(path_value: Any, maximum: int) -> dict[str, Any]:
    path = Path(str(path_value or "")).expanduser()
    if not path.is_absolute():
        raise RuntimeError("Foursday runtime status path is invalid")
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_mode & 0o077
        or metadata.st_size > maximum
        or path.resolve(strict=True) != path
    ):
        raise RuntimeError("Foursday runtime status file is unsafe")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("Foursday runtime status file is invalid")
    return value


def _live_runtime_status_context() -> str:
    release = _private_runtime_json(
        os.getenv("FOURSDAY_PROFILE_RELEASE_FILE"), 1024 * 1024,
    )
    state = _private_runtime_json(
        os.getenv("DWS_PERSONAL_STATE_FILE"), 16 * 1024 * 1024,
    )
    release_sha = str(os.getenv("FOURSDAY_RELEASE_SHA", "")).strip()
    if (
        release.get("schema") != "foursday-profile-release/v1"
        or not _FULL_RELEASE_SHA.fullmatch(release_sha)
        or release.get("foursdayCommit") != release_sha
    ):
        raise RuntimeError("Foursday live release identity is unavailable")
    mode = str(os.getenv("FOURSDAY_MODE", "unknown")).strip()
    configured_send = str(
        os.getenv("DWS_PERSONAL_SEND_ENABLED", "false")
    ).lower() == "true"
    send_blocked = state.get("sendBlocked") is True
    snapshot = {
        "source": "live_profile",
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "version": str(release.get("foursdayVersion") or ""),
        "releaseSha": release_sha,
        "mode": mode,
        "sendEnabled": configured_send and not send_blocked,
        "sendBlocked": send_blocked,
        "eventWakeReady": (state.get("eventWake") or {}).get("ready") is True,
    }
    return (
        "Authoritative live Foursday runtime snapshot captured by the connector: "
        + json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        + ". Answer naturally from this snapshot. Do not call tools for these fields, "
        "and do not use gbrain, README, release notes or prior Session values."
    )


_SHADOW_REPLY_KEYS: dict[str, set[str]] = {}
_WORK_CONTEXT_LOCK = threading.Lock()
_TURN_DELIVERY_VERSION: contextvars.ContextVar[Optional[dict[str, Any]]] = contextvars.ContextVar(
    "foursday_dws_delivery_version", default=None
)
_TURN_CONSUMED_DELIVERY_VERSION: contextvars.ContextVar[
    Optional[dict[str, Any]]
] = contextvars.ContextVar("foursday_dws_consumed_delivery_version", default=None)


def _work_context_token(
    *,
    project: Any,
    workspace: Optional[str] = None,
    session_key: str,
    project_context: str,
    memory_context: str,
    attachments: Optional[list[dict[str, Any]]] = None,
    owner_revision: int = 0,
    send_generation: int = 0,
    owner_intervention: Optional[str] = None,
    source_scope: str = "direct",
    requester_role: str = "trusted",
    provided_dingtalk_sources: Optional[list[dict[str, str]]] = None,
    related_projects: Optional[list[Any]] = None,
    related_gbrain_slugs: Optional[list[str]] = None,
) -> str:
    if owner_intervention not in {None, "task_correction", "resume_requested"}:
        raise RuntimeError("Foursday owner intervention is invalid")
    if (
        not isinstance(owner_revision, int) or owner_revision < 0
        or not isinstance(send_generation, int) or send_generation < 0
    ):
        raise RuntimeError("Foursday delivery revision is invalid")
    if source_scope not in {"direct", "group"}:
        raise RuntimeError("Foursday source scope is invalid")
    if requester_role not in {"owner", "trusted"}:
        raise RuntimeError("Foursday requester role is invalid")
    raw_sources = list(provided_dingtalk_sources or [])
    if len(raw_sources) > 4 or (source_scope != "direct" and raw_sources):
        raise RuntimeError("Foursday provided DingTalk sources are invalid")
    safe_sources = []
    seen_source_ids = set()
    seen_nodes = set()
    for item in raw_sources:
        if not isinstance(item, dict) or set(item) != {
            "sourceId", "kind", "nodeId", "messageHash", "requesterRole",
        }:
            raise RuntimeError("Foursday provided DingTalk source is invalid")
        source_id = str(item.get("sourceId") or "")
        node_id = str(item.get("nodeId") or "")
        item_role = str(item.get("requesterRole") or "")
        message_hash = str(item.get("messageHash") or "")
        if (
            not re.fullmatch(r"provided_[1-4]", source_id)
            or source_id in seen_source_ids
            or not re.fullmatch(r"[A-Za-z0-9]{20,80}", node_id)
            or node_id in seen_nodes
            or item.get("kind") != "doc"
            or item_role != requester_role
            or not re.fullmatch(r"[a-f0-9]{64}", message_hash)
        ):
            raise RuntimeError("Foursday provided DingTalk source is invalid")
        seen_source_ids.add(source_id)
        seen_nodes.add(node_id)
        safe_sources.append({
            "sourceId": source_id,
            "kind": "doc",
            "nodeId": node_id,
            "messageHash": message_hash,
            "requesterRole": requester_role,
        })
    configured = str(os.getenv("FOURSDAY_WORK_CONTEXT_FILE", "")).strip()
    if not configured or (project is None and not safe_sources):
        return ""
    project_id = str(getattr(project, "id", "") or "shared_link")
    related_scope_ids = [
        str(getattr(item, "id", "")) for item in list(related_projects or [])[:8]
        if str(getattr(item, "id", ""))
    ]
    related_memory = [
        str(value) for value in list(related_gbrain_slugs or [])[:12]
        if re.fullmatch(r"projects/[A-Za-z0-9._/-]{1,291}", str(value))
        and "//" not in str(value) and ".." not in str(value).split("/")
    ]
    project_root = str(getattr(project, "root", "") or workspace or "").strip()
    if not project_root:
        raise RuntimeError("Foursday dynamic-link fallback workspace is unavailable")
    path = Path(configured).expanduser()
    if not path.is_absolute():
        raise RuntimeError("Foursday work context path must be absolute")
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.parent.resolve(strict=True) != path.parent:
        raise RuntimeError("Foursday work context parent must not use a symlink")
    parent_metadata = path.parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or parent_metadata.st_mode & 0o077:
        raise RuntimeError("Foursday work context parent must be private")
    token = f"fctx_{secrets.token_hex(32)}"
    now = int(time.time())
    with _WORK_CONTEXT_LOCK:
        document: dict[str, Any] = {"schemaVersion": 1, "contexts": {}}
        if path.exists():
            metadata = path.lstat()
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_mode & 0o077
                or metadata.st_size > 1024 * 1024
            ):
                raise RuntimeError("Foursday work context file is unsafe")
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if (
                not isinstance(loaded, dict)
                or loaded.get("schemaVersion") != 1
                or not isinstance(loaded.get("contexts"), dict)
            ):
                raise RuntimeError("Foursday work context file is invalid")
            document = loaded
        contexts = {
            key: value for key, value in document["contexts"].items()
            if isinstance(value, dict) and int(value.get("expiresAt", 0)) > now
        }
        if len(contexts) >= 32:
            contexts = dict(sorted(
                contexts.items(), key=lambda item: int(item[1].get("expiresAt", 0)), reverse=True,
            )[:31])
        safe_attachments = []
        for item in list(attachments or [])[:8]:
            candidate = Path(str(item.get("path") or "")).expanduser()
            if not candidate.is_absolute() or not candidate.exists() or candidate.is_symlink():
                raise RuntimeError("Foursday attachment path is unsafe")
            canonical = candidate.resolve(strict=True)
            metadata = canonical.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size < 1 or metadata.st_size > 128 * 1024 * 1024:
                raise RuntimeError("Foursday attachment file is unsafe")
            safe_attachments.append({
                "path": str(canonical),
                "mimeType": str(item.get("mimeType") or "")[:120],
                "name": str(item.get("name") or canonical.name)[:255],
            })
        contexts[token] = {
            "projectId": project_id,
            "primaryScopeId": None if project_id == "shared_link" else project_id,
            "relatedScopeIds": list(dict.fromkeys(related_scope_ids)),
            "relatedGbrainSlugs": list(dict.fromkeys(related_memory)),
            "workspace": project_root,
            "projectContext": str(project_context or "")[:8_000],
            "memoryContext": str(memory_context or "")[:16_000],
            "sourcePrincipalHandle": secrets.token_hex(32),
            "sourceSessionHash": hashlib.sha256(session_key.encode("utf-8")).hexdigest(),
            "ownerRevision": int(owner_revision),
            "sendGeneration": int(send_generation),
            "ownerIntervention": owner_intervention,
            "sourceScope": source_scope,
            "requesterRole": requester_role,
            "providedDingtalkSources": safe_sources,
            "attachments": safe_attachments,
            "expiresAt": now + 15 * 60,
        }
        descriptor, temporary = tempfile.mkstemp(prefix=".work-context-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({"schemaVersion": 1, "contexts": contexts}, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return token


def _reply_evidence_key(event: dict[str, Any]) -> str:
    return ":".join(str(event.get(name) or "") for name in (
        "releaseSha", "conversationHash", "replyToHash", "deliveryContextHash", "contentHash",
    ))


def _shadow_evidence(event: dict[str, Any]) -> bool:
    configured = str(os.getenv("FOURSDAY_SHADOW_EVIDENCE_FILE", "")).strip()
    if not configured:
        return False
    path = Path(configured).expanduser()
    if not path.is_absolute():
        raise RuntimeError("Foursday shadow evidence path must be absolute")
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.parent.resolve(strict=True) != path.parent:
        raise RuntimeError("Foursday shadow evidence parent must not use a symlink")
    parent_metadata = path.parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or parent_metadata.st_mode & 0o077:
        raise RuntimeError("Foursday shadow evidence parent must be private")
    os.chmod(path.parent, 0o700)
    if path.exists():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise RuntimeError("Foursday shadow evidence must be a private regular file")
    release_sha = str(os.getenv("FOURSDAY_RELEASE_SHA", "")).strip().lower()
    event = {
        **event,
        "releaseSha": release_sha if re.fullmatch(r"[a-f0-9]{40}", release_sha) else None,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    if event.get("type") == "reply_attempt":
        key = _reply_evidence_key(event)
        known = _SHADOW_REPLY_KEYS.get(str(path))
        if known is None:
            known = set()
            if path.exists():
                for index, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
                    if index >= 100_000:
                        raise RuntimeError("Foursday shadow evidence is too large")
                    try:
                        prior = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if prior.get("type") == "reply_attempt":
                        known.add(_reply_evidence_key(prior))
            _SHADOW_REPLY_KEYS[str(path)] = known
        if key in known:
            return False
        known.add(key)
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.chmod(path, 0o600)
    return True


class UnavailableBridge:
    async def start(self, _callback: Callable[[dict], Awaitable[None]]) -> None:
        raise RuntimeError("DWS bridge is not configured")

    async def stop(self) -> None:
        return None

    async def send(self, _payload: dict) -> dict:
        return {"success": False, "error": "DWS bridge is not configured"}


class DwsPersonalAdapter(BasePlatformAdapter):
    supports_code_blocks = True
    supports_async_delivery = True
    splits_long_messages = False
    MAX_MESSAGE_LENGTH = 20_000

    @staticmethod
    def filter_local_delivery_paths(file_paths) -> list[str]:
        """Keep local Markdown citations out of Hermes' attachment fallback.

        Codex uses absolute local links as auditable citations. Hermes extracts
        those links after composing the text response and, on platforms without
        native document delivery, would otherwise send a second failure notice.
        Explicit MEDIA directives still use the separate media-delivery path.
        """
        del file_paths
        return []

    def __init__(
        self,
        config: PlatformConfig,
        bridge: Any = None,
        router: Any = None,
        memory: Any = None,
    ):
        super().__init__(config, Platform("dws_personal"))
        extra = config.extra or {}
        self._allowed_users = _strings(
            extra.get("allowed_users") or os.getenv("DWS_PERSONAL_ALLOWED_USERS")
        )
        self._allowed_groups = _strings(
            extra.get("allowed_groups") or os.getenv("DWS_PERSONAL_ALLOWED_GROUPS")
        )
        self._allow_all = bool(extra.get("allow_all")) or (
            str(os.getenv("DWS_PERSONAL_ALLOW_ALL_USERS", "")).lower() == "true"
        )
        self._enterprise_users_enabled = bool(extra.get("enterprise_users")) or (
            str(os.getenv("DWS_PERSONAL_ENTERPRISE_USERS_ENABLED", "")).lower() == "true"
        )
        # Hermes may only trust an adapter-owned gate when the live adapter
        # advertises an allowlist policy. DWS does not use Hermes pairing as
        # its allowlist: the host Sidecar verifies current-enterprise identity
        # before this adapter receives a record, then this adapter admits the
        # exact stable user for the lifetime of this connection.
        self._dm_policy = "allowlist"
        self._group_policy = "allowlist"
        self._gateway_authorized_users: set[str] = set()
        self._gateway_authorized_user_order = deque(maxlen=5_000)
        self._toolsets = list(extra.get("toolsets") or ["coding"])
        self._bundle_quiet_ms = _milliseconds(
            extra.get("bundle_quiet_ms")
            if "bundle_quiet_ms" in extra
            else os.getenv("DWS_PERSONAL_BUNDLE_QUIET_MS"),
            3_000,
            0,
            8_000,
        )
        self._bundle_max_wait_ms = _milliseconds(
            extra.get("bundle_max_wait_ms")
            if "bundle_max_wait_ms" in extra
            else os.getenv("DWS_PERSONAL_BUNDLE_MAX_WAIT_MS"),
            8_000,
            1,
            8_000,
        )
        if self._bundle_quiet_ms > self._bundle_max_wait_ms:
            raise ValueError("DWS bundle quiet window cannot exceed maximum wait")
        self._bridge = bridge or UnavailableBridge()
        self._router = router
        self._memory = memory
        self._seen = set()
        self._seen_order = deque(maxlen=5_000)
        self._pending: dict[str, list[dict]] = {}
        self._bundle_tasks: dict[str, asyncio.Task] = {}
        self._latest_delivery_versions: dict[str, dict[str, Any]] = {}
        self._provided_source_sessions: dict[str, tuple[float, list[dict[str, str]]]] = {}
        self._control_ack_tasks: set[asyncio.Task] = set()
        self._startup_release_task: Optional[asyncio.Task] = None

    @property
    def enforces_own_access_policy(self) -> bool:
        return True

    def toolsets_for_source(self, _source) -> Optional[list[str]]:
        return list(self._toolsets)

    def set_message_handler(self, handler) -> None:
        owner = getattr(handler, "__self__", None)
        drains_gateway_queue = bool(
            owner is not None
            and owner.__class__.__module__ == "gateway.run"
            and owner.__class__.__name__ == "GatewayRunner"
            and getattr(handler, "__name__", "") == "_handle_message"
        )

        async def tracked_handler(event: MessageEvent):
            _TURN_CONSUMED_DELIVERY_VERSION.set(None)
            event_version = _TURN_DELIVERY_VERSION.get()
            result = await handler(event)
            consumed = event_version
            if drains_gateway_queue:
                conversation_id = str(
                    getattr(event.source, "chat_id", "") or ""
                ).strip()
                consumed = self._latest_delivery_versions.get(conversation_id)
            if consumed is not None:
                _TURN_CONSUMED_DELIVERY_VERSION.set(dict(consumed))
            return result

        super().set_message_handler(tracked_handler)

    async def on_processing_start(self, event: MessageEvent) -> None:
        """Bind delivery to the exact event that owns this processing turn.

        Hermes creates a queued follow-up task from the active task's asyncio
        context. Without rebinding here, that new task inherits the previous
        turn's ContextVar and its otherwise-current answer is rejected by the
        DWS send-generation fence.
        """
        _TURN_CONSUMED_DELIVERY_VERSION.set(None)
        metadata = event.metadata if isinstance(event.metadata, dict) else {}
        owner_revision = metadata.get("owner_revision")
        send_generation = metadata.get("send_generation")
        conversation_id = str(getattr(event.source, "chat_id", "") or "").strip()
        if (
            conversation_id
            and isinstance(owner_revision, int)
            and owner_revision >= 0
            and isinstance(send_generation, int)
            and send_generation >= 0
        ):
            _TURN_DELIVERY_VERSION.set({
                "conversationId": conversation_id,
                "messageId": str(getattr(event, "message_id", "") or ""),
                "ownerRevision": owner_revision,
                "sendGeneration": send_generation,
                "turnStartedMonotonic": time.monotonic(),
                "detectionLatencyMs": metadata.get("detection_latency_ms"),
                "bundleWaitMs": metadata.get("bundle_wait_ms"),
                "wakeSource": metadata.get("wake_source"),
            })

    @staticmethod
    def _merge_queued_delivery_metadata(target: MessageEvent, latest: MessageEvent) -> None:
        target_metadata = target.metadata if isinstance(target.metadata, dict) else {}
        latest_metadata = latest.metadata if isinstance(latest.metadata, dict) else {}
        for key in (
            "owner_revision",
            "send_generation",
            "detected_at",
            "detection_latency_ms",
            "bundle_wait_ms",
            "wake_source",
        ):
            if key in latest_metadata:
                target_metadata[key] = latest_metadata[key]
        source_message_ids = []
        for metadata in (target_metadata, latest_metadata):
            for message_id in metadata.get("source_message_ids") or []:
                value = str(message_id)
                if value and value not in source_message_ids:
                    source_message_ids.append(value)
        if source_message_ids:
            target_metadata["source_message_ids"] = source_message_ids
            target_metadata["bundle_size"] = len(source_message_ids)
        target.metadata = target_metadata
        latest_markers = _FOURSDAY_CONTEXT_MARKER.findall(str(latest.text or ""))
        target_markers = _FOURSDAY_CONTEXT_MARKER.findall(str(target.text or ""))
        marker = (latest_markers or target_markers)[-1] if (latest_markers or target_markers) else None
        if marker:
            visible_text = _FOURSDAY_CONTEXT_MARKER.sub("", str(target.text or ""))
            visible_text = re.sub(r"\n{3,}", "\n\n", visible_text).strip()
            target.text = f"{visible_text}\n\n<!-- foursday-context:{marker} -->"
        if getattr(latest, "channel_prompt", None):
            target.channel_prompt = latest.channel_prompt

    async def _queue_text_debounce(self, session_key: str, event: MessageEvent) -> None:
        await super()._queue_text_debounce(session_key, event)
        state = self._text_debounce_store().get(session_key)
        if state is not None:
            self._merge_queued_delivery_metadata(state.event, event)

    async def _flush_text_debounce_now(self, session_key: str) -> bool:
        state = self._text_debounce_store().get(session_key)
        latest_event = state.event if state is not None else None
        flushed = await super()._flush_text_debounce_now(session_key)
        pending = self._pending_messages.get(session_key)
        if flushed and pending is not None and latest_event is not None:
            self._merge_queued_delivery_metadata(pending, latest_event)
        return flushed

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        del is_reconnect
        if self._running:
            return True
        if self._router is None:
            return False
        await self._bridge.start(self._on_record)
        self._running = True
        release_events = getattr(self._bridge, "release_events", None)
        if callable(release_events):
            async def release_after_gateway_registration() -> None:
                await asyncio.sleep(0.25)
                if self._running:
                    await release_events()

            self._startup_release_task = asyncio.create_task(
                release_after_gateway_registration()
            )
        return True

    async def disconnect(self) -> None:
        if self._startup_release_task is not None:
            self._startup_release_task.cancel()
            await asyncio.gather(self._startup_release_task, return_exceptions=True)
            self._startup_release_task = None
        pending = list(self._pending.values())
        self._pending.clear()
        for task in self._bundle_tasks.values():
            task.cancel()
        self._bundle_tasks.clear()
        for records in pending:
            await self._deliver_records(records)
        if self._control_ack_tasks:
            await asyncio.gather(*list(self._control_ack_tasks), return_exceptions=True)
            self._control_ack_tasks.clear()
        if self._running:
            await self._bridge.stop()
        self._running = False
        self._gateway_authorized_users.clear()
        self._gateway_authorized_user_order.clear()

    def _remember(self, message_id: str) -> bool:
        if message_id in self._seen:
            return False
        if len(self._seen_order) == self._seen_order.maxlen:
            expired = self._seen_order.popleft()
            self._seen.discard(expired)
        self._seen_order.append(message_id)
        self._seen.add(message_id)
        return True

    def _user_allowed(self, user_id: str, enterprise_verified: bool = False) -> bool:
        return (
            self._allow_all
            or bool(user_id and user_id in self._allowed_users)
            or bool(self._enterprise_users_enabled and user_id and enterprise_verified)
        )

    def _remember_gateway_authorized_user(self, user_id: str) -> None:
        value = str(user_id or "").strip()
        if not value or value in self._gateway_authorized_users:
            return
        if len(self._gateway_authorized_user_order) == self._gateway_authorized_user_order.maxlen:
            expired = self._gateway_authorized_user_order.popleft()
            self._gateway_authorized_users.discard(expired)
        self._gateway_authorized_user_order.append(value)
        self._gateway_authorized_users.add(value)

    def _is_dm_allowed(self, user_id: str) -> bool:
        return str(user_id or "").strip() in self._gateway_authorized_users

    async def _emit_control(self, record: Dict[str, Any]) -> None:
        conversation_id = str(record.get("conversationId") or "").strip()
        participant_id = str(record.get("participantUserId") or "").strip()
        chat_type = str(record.get("chatType") or "direct").strip()
        if (
            not conversation_id
            or not participant_id
            or not self._user_allowed(
                participant_id,
                enterprise_verified=record.get("enterpriseVerified") is True,
            )
            or chat_type not in {"direct", "group"}
        ):
            return
        self._remember_gateway_authorized_user(participant_id)
        session_key = f"{conversation_id}:{participant_id}"
        source = self.build_source(
            chat_id=conversation_id,
            chat_type="dm" if chat_type == "direct" else "group",
            user_id=participant_id,
            message_id=str(record.get("id") or "control"),
        )
        control = str(record.get("control") or "").strip()
        if control in {"task_correction", "task_takeover", "resume_requested"}:
            await self.interrupt_session_activity(session_key, conversation_id)
        _shadow_evidence({
            "schema": "foursday-shadow-event/v1",
            "type": control,
            "conversationHash": _digest(conversation_id),
            "participantHash": _digest(participant_id),
            "occurredAt": str(record.get("createTime") or "") or None,
        })
        handler = getattr(self, "_platform_event_handler", None)
        if handler is not None and control in {
            "communication_takeover", "task_correction", "task_takeover",
            "resume_requested", "unrelated_owner_message", "message_withdrawn",
        }:
            await handler({
                "type": control,
                "conversation_id": conversation_id,
                "participant_id": participant_id,
                "message_id": str(record.get("messageId") or "") or None,
                "occurred_at": str(record.get("createTime") or "") or None,
                "owner_revision": record.get("ownerRevision"),
                "send_generation": record.get("sendGeneration"),
            }, source)
        if control in {"task_correction", "resume_requested"}:
            owner_content = str(record.get("ownerContent") or "").strip()
            if owner_content:
                await self._deliver_records([{
                    "id": str(record.get("ownerMessageId") or record.get("id") or "owner-control"),
                    "senderUserId": participant_id,
                    "senderName": "Foursday owner",
                    "conversationId": conversation_id,
                    "content": owner_content,
                    "createTime": str(record.get("createTime") or ""),
                    "chatType": chat_type,
                    "mentionedSelf": chat_type == "group",
                    "isSelf": False,
                    "attachments": [],
                    "ownerRevision": int(record.get("ownerRevision") or 0),
                    "sendGeneration": int(record.get("sendGeneration") or 0),
                    "ownerIntervention": control,
                }])
        task_id = str(record.get("taskId") or "").strip()
        event_id = str(record.get("controlEventId") or "").strip()
        acknowledge = getattr(self._bridge, "ack_control", None)
        if task_id and event_id and callable(acknowledge):
            async def acknowledge_after_callback() -> None:
                receipt = await acknowledge(task_id, event_id)
                if not isinstance(receipt, dict) or receipt.get("success") is not True:
                    raise RuntimeError("Foursday control acknowledgement failed")

            task = asyncio.create_task(acknowledge_after_callback())
            self._control_ack_tasks.add(task)

            def finish_ack(completed: asyncio.Task) -> None:
                self._control_ack_tasks.discard(completed)
                try:
                    completed.result()
                except Exception:
                    _shadow_evidence({
                        "schema": "foursday-shadow-event/v1",
                        "type": "control_ack_failed",
                        "conversationHash": _digest(conversation_id),
                        "participantHash": _digest(participant_id),
                        "occurredAt": str(record.get("createTime") or "") or None,
                    })

            task.add_done_callback(finish_ack)

    async def _bundle_after(self, key: str) -> None:
        current_task = asyncio.current_task()
        try:
            while key in self._pending:
                records = self._pending[key]
                now = asyncio.get_running_loop().time() * 1_000
                due = min(
                    records[0]["_received_monotonic_ms"] + self._bundle_max_wait_ms,
                    records[-1]["_received_monotonic_ms"] + self._bundle_quiet_ms,
                )
                if due > now:
                    await asyncio.sleep((due - now) / 1_000)
                    continue
                records = self._pending.pop(key, [])
                if self._bundle_tasks.get(key) is current_task:
                    self._bundle_tasks.pop(key, None)
                if records:
                    await self._deliver_records(records)
                return
        finally:
            if self._bundle_tasks.get(key) is current_task:
                self._bundle_tasks.pop(key, None)
            if key in self._pending and key not in self._bundle_tasks:
                self._bundle_tasks[key] = asyncio.create_task(self._bundle_after(key))

    async def _queue_record(self, record: Dict[str, Any]) -> None:
        if self._bundle_quiet_ms == 0:
            await self._deliver_records([record])
            return
        key = f"{record['chatType']}:{record['conversationId']}:{record['senderUserId']}"
        existing = self._pending.get(key, [])
        if existing:
            previous_at = datetime.fromisoformat(
                str(existing[-1].get("createTime") or "").replace("Z", "+00:00")
            )
            current_at = datetime.fromisoformat(
                str(record.get("createTime") or "").replace("Z", "+00:00")
            )
            source_gap_ms = (current_at - previous_at).total_seconds() * 1_000
            if source_gap_ms > self._bundle_max_wait_ms:
                records = self._pending.pop(key, [])
                task = self._bundle_tasks.pop(key, None)
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                if records:
                    await self._deliver_records(records)
        record = {
            **record,
            "_received_monotonic_ms": asyncio.get_running_loop().time() * 1_000,
        }
        self._pending.setdefault(key, []).append(record)
        if key not in self._bundle_tasks:
            self._bundle_tasks[key] = asyncio.create_task(self._bundle_after(key))

    async def _deliver_records(self, records: list[Dict[str, Any]]) -> None:
        if not records:
            return
        records = sorted(records, key=lambda item: str(item.get("createTime") or ""))
        latest = records[-1]
        bundle_wait_ms = max(0, int(
            time.monotonic() * 1_000 -
            float(records[0].get("_received_monotonic_ms") or time.monotonic() * 1_000)
        ))
        detection_latency_ms = latest.get("detectionLatencyMs")
        if not isinstance(detection_latency_ms, (int, float)) or detection_latency_ms < 0:
            detection_latency_ms = None
        wake_source = str(latest.get("wakeSource") or "unknown")[:40]
        message_ids = [str(item["id"]) for item in records]
        content = "\n".join(str(item["content"]).strip() for item in records).strip()
        attachments = [
            attachment
            for record in records
            for attachment in list(record.get("attachments") or [])[:8]
        ][:8]
        resource_enrichment_unavailable = any(
            record.get("resourceEnrichmentUnavailable") is True for record in records
        )
        conversation_id = str(latest["conversationId"])
        user_id = str(latest["senderUserId"])
        open_id = str(latest.get("senderOpenDingTalkId") or "").strip()
        chat_type = str(latest["chatType"])
        self_user_id = str(os.getenv("DINGTALK_SELF_USER_ID", "")).strip()
        requester_role = (
            "owner"
            if chat_type == "direct" and self_user_id and user_id == self_user_id
            else "trusted"
        )
        provided_sources = (
            _provided_dingtalk_sources(
                content,
                message_ids=message_ids,
                requester_role=requester_role,
            )
            if chat_type == "direct"
            else []
        )
        timestamp = datetime.fromisoformat(
            str(latest.get("createTime") or "").replace("Z", "+00:00")
        )
        session_key = f"{conversation_id}:{user_id}"
        if provided_sources:
            bound_selection = getattr(self._router, "bound_selection", None)
            previous_selection = bound_selection(session_key) if callable(bound_selection) else None
            previous_scope = (
                str(previous_selection.get("primaryScopeId") or "")
                if previous_selection else "none"
            )
            route = SimpleNamespace(
                status="link_intake",
                project=None,
                workspace_path=str(self._router.fallback_workspace),
                context=(
                    "A verified enterprise sender provided one or more exact DingTalk documents. "
                    "Read those provided sources in the isolated fallback, then let Codex classify "
                    "the project from the request, document evidence, prior Thread and project list. "
                    f"The prior primary scope was {previous_scope}; it is context, not a constraint. "
                    "The sender identity is never project evidence."
                ),
            )
        else:
            route = self._router.route(text=content, session_key=session_key)
        runtime_status_required = bool(_CURRENT_RUNTIME_STATUS.search(content))
        runtime_status_context = ""
        if runtime_status_required:
            try:
                runtime_status_context = _live_runtime_status_context()
            except Exception:
                runtime_status_context = (
                    "This request asks for current Foursday operational status. "
                    "Call foursday_runtime_status with the current context token. "
                    "If it is unavailable, say live status cannot be confirmed. "
                    "Do not use gbrain, README, release notes or prior Session values."
                )
        memory_context = ""
        memory_status = "skipped_live_status" if runtime_status_required else "not_configured"
        if self._memory is not None and not runtime_status_required:
            try:
                memory_context = await self._memory.context_for_route(route)
                memory_status = "available" if memory_context else "empty"
            except Exception:
                memory_status = "unavailable"
        current_time = time.time()
        self._provided_source_sessions = {
            key: value for key, value in self._provided_source_sessions.items()
            if value[0] > current_time
        }
        if provided_sources:
            self._provided_source_sessions[session_key] = (
                current_time + 15 * 60,
                [dict(source) for source in provided_sources],
            )
        elif session_key in self._provided_source_sessions:
            provided_sources = [
                dict(source) for source in self._provided_source_sessions[session_key][1]
            ]
        if len(self._provided_source_sessions) > 1_000:
            self._provided_source_sessions = dict(sorted(
                self._provided_source_sessions.items(),
                key=lambda item: item[1][0],
                reverse=True,
            )[:1_000])
        latest_delivery_version = {
            "conversationId": conversation_id,
            "messageId": message_ids[-1],
            "ownerRevision": int(latest.get("ownerRevision") or 0),
            "sendGeneration": int(latest.get("sendGeneration") or 0),
            "turnStartedMonotonic": time.monotonic(),
            "detectionLatencyMs": detection_latency_ms,
            "bundleWaitMs": bundle_wait_ms,
            "wakeSource": wake_source,
        }
        self._latest_delivery_versions.pop(conversation_id, None)
        self._latest_delivery_versions[conversation_id] = latest_delivery_version
        while len(self._latest_delivery_versions) > 1_000:
            self._latest_delivery_versions.pop(next(iter(self._latest_delivery_versions)))
        context_token = _work_context_token(
            project=getattr(route, "project", None),
            workspace=getattr(route, "workspace_path", None),
            session_key=session_key,
            project_context=route.context,
            memory_context=memory_context,
            attachments=attachments,
            owner_revision=int(latest.get("ownerRevision") or 0),
            send_generation=int(latest.get("sendGeneration") or 0),
            owner_intervention=(
                str(latest.get("ownerIntervention"))
                if latest.get("ownerIntervention") in {"task_correction", "resume_requested"}
                else None
            ),
            source_scope=chat_type,
            requester_role=requester_role,
            provided_dingtalk_sources=provided_sources,
            related_projects=list(getattr(route, "related_projects", ()) or ()),
            related_gbrain_slugs=list(getattr(route, "related_gbrain_slugs", ()) or ()),
        )
        tool_context = (
            "Foursday work context token: " + context_token +
            ". Pass it only as contextToken to Foursday MCP tools. Never quote it in a reply. "
            "DingTalk document links captured from this message are available through "
            "foursday_list_project_sources and foursday_read_project_source. Never probe, "
            "install or call dws from the Codex shell; use the MCP error code to distinguish "
            "bounded host busy, host unavailability, project-scope denial and document read failure."
            if context_token else ""
        )
        resource_context = (
            "One or more message attachment details could not be read after a bounded retry. "
            "Use the visible text, but do not claim to have opened or summarized the missing attachment; "
            "ask the requester to resend it only when the file is necessary to complete the task."
            if resource_enrichment_unavailable else ""
        )
        channel_prompt = "\n\n".join(
            item for item in [
                route.context,
                memory_context,
                runtime_status_context,
                tool_context,
                resource_context,
            ] if item
        )
        source = self.build_source(
            chat_id=conversation_id,
            chat_type="dm" if chat_type == "direct" else "group",
            user_id=user_id,
            user_id_alt=open_id or None,
            user_name=str(latest.get("senderName") or "").strip() or user_id,
            message_id=message_ids[-1],
        )
        visible_content = content or "Please inspect the attached file or image."
        agent_text = (
            visible_content + f"\n\n<!-- foursday-context:{context_token} -->"
            if context_token else visible_content
        )
        media_urls = [str(item["path"]) for item in attachments if item.get("path")]
        media_types = [str(item.get("mimeType") or "") for item in attachments if item.get("path")]
        has_image = any(value.lower().startswith("image/") for value in media_types)
        event = MessageEvent(
            text=agent_text,
            message_type=MessageType.PHOTO if has_image else MessageType.DOCUMENT if media_urls else MessageType.TEXT,
            user_id=user_id,
            user_name=source.user_name,
            source=source,
            raw_message={"transport": "dws", "normalized": True},
            message_id=message_ids[-1],
            timestamp=timestamp,
            channel_prompt=channel_prompt,
            media_urls=media_urls,
            media_types=media_types,
            metadata={
                "dws_identity_verified": True,
                "project_route_status": getattr(route, "status", "unknown"),
                "personal_memory_status": memory_status,
                "source_message_ids": message_ids,
                "bundle_size": len(records),
                "owner_revision": int(latest.get("ownerRevision") or 0),
                "send_generation": int(latest.get("sendGeneration") or 0),
                "owner_intervention": latest.get("ownerIntervention"),
                "detected_at": str(latest.get("detectedAt") or "") or None,
                "detection_latency_ms": detection_latency_ms,
                "bundle_wait_ms": bundle_wait_ms,
                "wake_source": wake_source,
                "enterprise_verified": latest.get("enterpriseVerified") is True,
                "resource_enrichment_unavailable": resource_enrichment_unavailable,
            },
        )
        _shadow_evidence({
            "schema": "foursday-shadow-event/v1",
            "type": "inbound",
            "conversationHash": _digest(conversation_id),
            "participantHash": _digest(user_id),
            "messageHashes": [_digest(value) for value in message_ids],
            "projectId": getattr(getattr(route, "project", None), "id", None),
            "routeStatus": getattr(route, "status", "unknown"),
            "memoryStatus": memory_status,
            "bundleSize": len(records),
            "occurredAt": timestamp.isoformat(),
            "detectedAt": str(latest.get("detectedAt") or "") or None,
            "detectionLatencyMs": detection_latency_ms,
            "bundleWaitMs": bundle_wait_ms,
            "wakeSource": wake_source,
        })
        from project_router.runtime_context import routed_project_scope

        delivery_version = _TURN_DELIVERY_VERSION.set(dict(latest_delivery_version))
        try:
            with routed_project_scope(route, principal_id=user_id):
                await self.handle_message(event)
        finally:
            _TURN_DELIVERY_VERSION.reset(delivery_version)

    async def _on_record(self, record: Dict[str, Any]) -> None:
        if not isinstance(record, dict):
            return
        if record.get("control"):
            await self._emit_control(record)
            return
        if record.get("isSelf") is True:
            return
        message_id = str(record.get("id") or "").strip()
        conversation_id = str(record.get("conversationId") or "").strip()
        user_id = str(record.get("senderUserId") or "").strip()
        open_id = str(record.get("senderOpenDingTalkId") or "").strip()
        content = str(record.get("content") or "").strip()
        attachments = list(record.get("attachments") or [])
        chat_type = str(record.get("chatType") or "").strip()
        if (
            not message_id
            or not conversation_id
            or not user_id
            or (not content and not attachments)
            or chat_type not in {"direct", "group"}
            or not self._user_allowed(
                user_id,
                enterprise_verified=record.get("enterpriseVerified") is True,
            )
            or not self._remember(message_id)
        ):
            return
        if chat_type == "group":
            if conversation_id not in self._allowed_groups:
                return
            if record.get("mentionedSelf") is not True:
                return
        try:
            datetime.fromisoformat(str(record.get("createTime") or "").replace("Z", "+00:00"))
        except ValueError:
            return
        self._remember_gateway_authorized_user(user_id)
        await self._queue_record({
            **record,
            "id": message_id,
            "conversationId": conversation_id,
            "senderUserId": user_id,
            "senderOpenDingTalkId": open_id or None,
            "content": content,
            "attachments": attachments,
            "chatType": chat_type,
        })

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if _INTERNAL_GATEWAY_NOTICE.search(str(content).strip()):
            message_id = hashlib.sha256(str(content).encode("utf-8")).hexdigest()[:24]
            return SendResult(
                success=True,
                message_id=f"suppressed-internal-{message_id}",
            )
        if _OUTBOUND_SECRET.search(str(content)) or _IRREVERSIBLE_COMMITMENT.search(str(content)):
            return SendResult(
                success=False,
                error="Foursday blocked secret material or an irreversible commitment",
                retryable=False,
            )
        payload = {
            "conversationId": str(chat_id),
            "content": _dingtalk_plain_text(content),
            "replyTo": str(reply_to) if reply_to else None,
            "metadata": dict(metadata or {}),
        }
        version = _TURN_DELIVERY_VERSION.get()
        if version is None and isinstance(metadata, dict):
            owner_revision = metadata.get("foursday_owner_revision")
            send_generation = metadata.get("foursday_send_generation")
            if isinstance(owner_revision, int) and isinstance(send_generation, int):
                version = {
                    "conversationId": str(chat_id),
                    "ownerRevision": owner_revision,
                    "sendGeneration": send_generation,
                }
        anchor_rebound = False
        latest_version = self._latest_delivery_versions.get(str(chat_id))
        consumed_version = _TURN_CONSUMED_DELIVERY_VERSION.get()
        latest_reply_anchor = bool(
            reply_to
            and latest_version is not None
            and latest_version.get("conversationId") == str(chat_id)
            and secrets.compare_digest(
                str(reply_to), str(latest_version.get("messageId") or "")
            )
        )
        processing_root_reply_anchor = bool(
            version is not None
            and version.get("conversationId") == str(chat_id)
            and reply_to
            and isinstance(metadata, dict)
            and metadata.get("notify") is True
            and secrets.compare_digest(
                str(reply_to), str(version.get("messageId") or "")
            )
        )
        consumed_is_latest = bool(
            consumed_version is not None
            and latest_version is not None
            and consumed_version.get("conversationId") == str(chat_id)
            and latest_version.get("conversationId") == str(chat_id)
            and secrets.compare_digest(
                str(consumed_version.get("messageId") or ""),
                str(latest_version.get("messageId") or ""),
            )
            and int(consumed_version.get("ownerRevision") or 0)
            == int(latest_version.get("ownerRevision") or 0)
            and int(consumed_version.get("sendGeneration") or 0)
            == int(latest_version.get("sendGeneration") or 0)
        )
        if (
            version is not None
            and version.get("conversationId") == str(chat_id)
            and (latest_reply_anchor or processing_root_reply_anchor)
            and consumed_is_latest
            and int(consumed_version.get("ownerRevision") or 0) >= int(
                version.get("ownerRevision") or 0
            )
            and int(consumed_version.get("sendGeneration") or 0) >= int(
                version.get("sendGeneration") or 0
            )
            and (
                int(consumed_version.get("ownerRevision") or 0)
                > int(version.get("ownerRevision") or 0)
                or int(consumed_version.get("sendGeneration") or 0)
                > int(version.get("sendGeneration") or 0)
            )
        ):
            version = consumed_version
            anchor_rebound = True
        if version is None or version.get("conversationId") != str(chat_id):
            return SendResult(
                success=False,
                error="Foursday delivery generation is unavailable",
                retryable=False,
            )
        payload["ownerRevision"] = int(version["ownerRevision"])
        payload["sendGeneration"] = int(version["sendGeneration"])
        agent_duration_ms = None
        if isinstance(version.get("turnStartedMonotonic"), (int, float)):
            agent_duration_ms = max(0, int(
                (time.monotonic() - float(version["turnStartedMonotonic"])) * 1_000
            ))
        result = await self._bridge.send(payload)
        _shadow_evidence({
            "schema": "foursday-shadow-event/v1",
            "type": "reply_attempt",
            "conversationHash": _digest(chat_id),
            "replyToHash": _digest(reply_to) if reply_to else None,
            "deliveryContextHash": hashlib.sha256(
                json.dumps(metadata or {}, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()[:16],
            "contentHash": hashlib.sha256(str(content).encode("utf-8")).hexdigest(),
            "contentBytes": len(str(content).encode("utf-8")),
            "mode": str(os.getenv("FOURSDAY_MODE", "unknown")),
            "bridgeSuccess": bool(
                isinstance(result, dict) and result.get("success") is True
            ),
            "outcomeUnknown": bool(
                isinstance(result, dict) and result.get("outcomeUnknown") is True
            ),
            "receiptKind": str(result.get("receiptKind") or "")[:40]
            if isinstance(result, dict) else None,
            "detectionLatencyMs": version.get("detectionLatencyMs"),
            "bundleWaitMs": version.get("bundleWaitMs"),
            "agentDurationMs": agent_duration_ms,
            "wakeSource": version.get("wakeSource"),
            "ownerRevision": int(version.get("ownerRevision") or 0),
            "sendGeneration": int(version.get("sendGeneration") or 0),
            "latestReplyAnchor": latest_reply_anchor,
            "processingRootReplyAnchor": processing_root_reply_anchor,
            "consumedLatestVersion": consumed_is_latest,
            "generationRebound": anchor_rebound,
        })
        if not isinstance(result, dict) or result.get("success") is not True:
            shadow_mode = str(
                os.getenv("FOURSDAY_MODE", "")
            ).strip().lower() == "shadow"
            if shadow_mode and isinstance(result, dict) and result.get("sendDisabled") is True:
                shadow_id = hashlib.sha256(
                    f"{chat_id}\n{content}".encode("utf-8")
                ).hexdigest()[:24]
                return SendResult(
                    success=True,
                    message_id=f"shadow-{shadow_id}",
                )
            if isinstance(result, dict) and result.get("outcomeUnknown") is True:
                suppressed_id = hashlib.sha256(
                    f"{chat_id}\n{content}".encode("utf-8")
                ).hexdigest()[:24]
                return SendResult(
                    success=True,
                    message_id=f"suppressed-unknown-{suppressed_id}",
                )
            if isinstance(result, dict) and result.get("staleGeneration") is True:
                suppressed_id = hashlib.sha256(
                    f"{chat_id}\n{content}".encode("utf-8")
                ).hexdigest()[:24]
                return SendResult(
                    success=True,
                    message_id=f"suppressed-stale-{suppressed_id}",
                )
            return SendResult(
                success=False,
                error="DWS bridge did not return an explicit success receipt",
                retryable=not bool(isinstance(result, dict) and (
                    result.get("outcomeUnknown") is True or result.get("staleGeneration") is True
                )),
            )
        message_id = str(result.get("messageId") or "").strip()
        if not message_id:
            return SendResult(
                success=False,
                error="DWS bridge success receipt did not include a message ID",
            )
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        del chat_id, metadata

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": str(chat_id), "type": "dm", "chat_id": str(chat_id)}
