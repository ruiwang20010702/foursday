"""Compose Foursday's native Hermes extensions inside one profile boundary."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import threading
import time
import secrets


_COMPONENTS = (
    "dws_personal",
    "project_router",
)
_CONTEXT_MARKER = re.compile(r"<!-- foursday-context:(fctx_[a-f0-9]{64}) -->")
_SCHEDULE_MARKER = re.compile(r"<!-- foursday-schedule:([a-z0-9][a-z0-9_-]{0,63}) -->")
_CONTEXT_LOCK = threading.Lock()


def _pin_workspace(value: object) -> str:
    workspace = Path(str(value or "").strip()).expanduser()
    if (
        not workspace.is_absolute()
        or not workspace.exists()
        or workspace.is_symlink()
        or not workspace.is_dir()
        or workspace.resolve(strict=True) != workspace
    ):
        raise RuntimeError("Foursday routed workspace is unsafe")
    from agent.runtime_cwd import set_session_cwd
    set_session_cwd(str(workspace))
    return str(workspace)


def _bounded_identity(value: object, label: str) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 500 or any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise RuntimeError(f"Foursday {label} is invalid")
    return text


def _hash_identity(value: object, label: str) -> str:
    return hashlib.sha256(_bounded_identity(value, label).encode("utf-8")).hexdigest()


def _enrich_work_context(
    *,
    user_message: object,
    session_id: object,
    turn_id: object,
    sender_id: object,
    platform: object,
    now: int | None = None,
) -> bool:
    matched = _CONTEXT_MARKER.search(str(user_message or ""))
    if matched is None:
        return False
    configured = str(os.getenv("FOURSDAY_WORK_CONTEXT_FILE", "")).strip()
    path = Path(configured).expanduser()
    if not path.is_absolute() or not path.exists() or path.is_symlink():
        raise RuntimeError("Foursday work context path is unsafe")
    parent = path.parent.resolve(strict=True)
    if parent != path.parent or parent.is_symlink():
        raise RuntimeError("Foursday work context parent is unsafe")
    parent_metadata = parent.lstat()
    metadata = path.lstat()
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_mode & 0o077
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_mode & 0o077
        or metadata.st_size > 1024 * 1024
    ):
        raise RuntimeError("Foursday work context file is unsafe")
    timestamp = int(time.time()) if now is None else int(now)
    token = matched.group(1)
    with _CONTEXT_LOCK:
        document = json.loads(path.read_text(encoding="utf-8"))
        contexts = document.get("contexts") if document.get("schemaVersion") == 1 else None
        context = contexts.get(token) if isinstance(contexts, dict) else None
        if not isinstance(context, dict) or int(context.get("expiresAt", 0)) <= timestamp:
            raise RuntimeError("Foursday work context is unavailable")
        _pin_workspace(context.get("workspace"))
        context.update({
            "hermesSessionHash": _hash_identity(session_id, "session id"),
            "hermesTurnHash": _hash_identity(turn_id, "turn id"),
            "sourcePrincipalHash": _hash_identity(sender_id, "sender id"),
            "platform": _bounded_identity(platform, "platform")[:80],
        })
        descriptor, temporary = tempfile.mkstemp(prefix=".work-context-hook-", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return True


def _scheduled_work_context(
    *,
    user_message: object,
    session_id: object,
    turn_id: object,
    platform: object,
    now: int | None = None,
) -> str:
    matches = list(_SCHEDULE_MARKER.finditer(str(user_message or "")))
    if not matches:
        return ""
    if len(matches) != 1:
        raise RuntimeError("Foursday scheduled project marker is ambiguous")
    matched = matches[0]
    if str(platform or "").strip().lower() != "cron":
        raise RuntimeError("Foursday schedule marker is restricted to Hermes cron")
    registry_path = Path(str(os.getenv("FOURSDAY_PROJECT_REGISTRY", "")).strip()).expanduser()
    context_path = Path(str(os.getenv("FOURSDAY_WORK_CONTEXT_FILE", "")).strip()).expanduser()
    for path, label in ((registry_path, "project registry"), (context_path.parent, "context parent")):
        if not path.is_absolute() or not path.exists() or path.is_symlink():
            raise RuntimeError(f"Foursday scheduled {label} is unsafe")
        if path.resolve(strict=True) != path:
            raise RuntimeError(f"Foursday scheduled {label} is unsafe")
    registry_metadata = registry_path.lstat()
    if (
        not stat.S_ISREG(registry_metadata.st_mode)
        or registry_metadata.st_mode & 0o077
        or registry_metadata.st_size > 1024 * 1024
    ):
        raise RuntimeError("Foursday scheduled project registry is unsafe")
    from project_router.registry import ProjectRegistry

    fallback_workspace = str(os.getenv("FOURSDAY_FALLBACK_WORKSPACE", "")).strip()
    if not fallback_workspace:
        raw_registry = json.loads(registry_path.read_text(encoding="utf-8"))
        if raw_registry.get("schemaVersion") == 1:
            fallback_workspace = str((raw_registry.get("projects") or [{}])[0].get("root") or "")
        elif raw_registry.get("schemaVersion") == 2:
            fallback_workspace = str((raw_registry.get("workspaces") or [{}])[0].get("root") or "")
    registry = ProjectRegistry.load(
        str(registry_path),
        fallback_workspace=fallback_workspace,
    )
    project = next((item for item in registry.projects if item.id == matched.group(1)), None)
    if project is None:
        raise RuntimeError("Foursday scheduled project is unavailable")
    workspace = Path(_pin_workspace(project.root))
    timestamp = int(time.time()) if now is None else int(now)
    token = f"fctx_{secrets.token_hex(32)}"
    slugs = ", ".join(str(value) for value in list(project.gbrain_slugs or ())[:32]) or "none"
    project_context = (
        f"Foursday primary work scope: {project.name} ({project.id}).\n"
        f"Scope lineage: {' > '.join(project.lineage or (project.id,))}\n"
        f"Workspace: {workspace}\n"
        f"gbrain pages: {slugs}\n"
        f"Run instructions: {str(project.run_instructions or 'Read project instructions first.')[:2000]}"
    )
    parent = context_path.parent.resolve(strict=True)
    parent_metadata = parent.lstat()
    if parent != context_path.parent or parent.is_symlink() or parent_metadata.st_mode & 0o077:
        raise RuntimeError("Foursday scheduled context parent is unsafe")
    with _CONTEXT_LOCK:
        document: dict[str, object] = {"schemaVersion": 1, "contexts": {}}
        if context_path.exists():
            metadata = context_path.lstat()
            if (
                context_path.is_symlink()
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_mode & 0o077
                or metadata.st_size > 1024 * 1024
            ):
                raise RuntimeError("Foursday scheduled context file is unsafe")
            document = json.loads(context_path.read_text(encoding="utf-8"))
        contexts = document.get("contexts") if document.get("schemaVersion") == 1 else None
        if not isinstance(contexts, dict):
            raise RuntimeError("Foursday scheduled context file is invalid")
        contexts = {
            key: value for key, value in contexts.items()
            if isinstance(value, dict) and int(value.get("expiresAt", 0)) > timestamp
        }
        if len(contexts) >= 32:
            contexts = dict(sorted(
                contexts.items(), key=lambda item: int(item[1].get("expiresAt", 0)), reverse=True,
            )[:31])
        contexts[token] = {
            "projectId": str(project.id),
            "primaryScopeId": str(project.id),
            "relatedScopeIds": [],
            "relatedGbrainSlugs": [],
            "workspace": str(workspace),
            "projectContext": project_context[:8000],
            "memoryContext": "",
            "sourcePrincipalHandle": secrets.token_hex(32),
            "sourceSessionHash": _hash_identity(session_id, "session id"),
            "hermesSessionHash": _hash_identity(session_id, "session id"),
            "hermesTurnHash": _hash_identity(turn_id, "turn id"),
            "sourcePrincipalHash": hashlib.sha256(b"foursday-owner-scheduled").hexdigest(),
            "platform": "cron",
            "sourceScope": "cron",
            "requesterRole": "system",
            "providedDingtalkSources": [],
            "ownerRevision": 0,
            "sendGeneration": 0,
            "attachments": [],
            "expiresAt": timestamp + 15 * 60,
        }
        descriptor, temporary = tempfile.mkstemp(prefix=".work-context-cron-", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({"schemaVersion": 1, "contexts": contexts}, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, context_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return token


def _on_pre_llm_call(**kwargs):
    if _enrich_work_context(
        user_message=kwargs.get("user_message"),
        session_id=kwargs.get("session_id"),
        turn_id=kwargs.get("turn_id"),
        sender_id=kwargs.get("sender_id"),
        platform=kwargs.get("platform"),
    ):
        return None
    token = _scheduled_work_context(
        user_message=kwargs.get("user_message"),
        session_id=kwargs.get("session_id"),
        turn_id=kwargs.get("turn_id"),
        platform=kwargs.get("platform"),
    )
    return {"context": f"<!-- foursday-context:{token} -->"} if token else None


def _trusted_plugin_root() -> Path:
    plugin = Path(__file__).resolve(strict=True).parent
    root = plugin.parent
    hermes_home = Path(os.getenv("HERMES_HOME", "")).expanduser().resolve(strict=True)
    expected = hermes_home / "plugins"
    if root != expected or root.is_symlink():
        raise RuntimeError("Foursday component plugins must remain inside the active profile")
    if plugin != root / "foursday_work_twin":
        raise RuntimeError("Foursday composition plugin identity mismatch")
    components = plugin / "components"
    for name in _COMPONENTS:
        directory = components / name
        metadata = directory.lstat()
        manifest = directory / "plugin.yaml"
        manifest_metadata = manifest.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or directory.is_symlink()
            or not stat.S_ISREG(manifest_metadata.st_mode)
            or manifest.is_symlink()
        ):
            raise RuntimeError("Foursday component plugin layout is unsafe")
    return components


def register(ctx) -> None:
    root = _trusted_plugin_root()
    components_text = str(root)
    if components_text not in sys.path:
        sys.path.insert(0, components_text)
    from dws_personal import register as register_dws

    register_dws(ctx)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)


__all__ = ["register"]
