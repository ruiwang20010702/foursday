"""Project identity registry with conversation-scoped workspace routing."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import stat as stat_module
import threading
import tempfile
import unicodedata
from typing import Iterable, Optional
from urllib.parse import urlsplit


_PROJECT_KEYS = {
    "id", "name", "aliases", "root", "gitRemote",
    "gbrainSlugs", "runInstructions", "dingtalkSources",
}
_PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_GBRAIN_SLUG = re.compile(r"^[\w./-]{1,300}$", re.UNICODE)
_DINGTALK_NODE_ID = re.compile(r"^[A-Za-z0-9]{20,80}$")


def _text(value, name: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > maximum:
        raise ValueError(f"{name} is invalid")
    return normalized


def _text_list(value, name: str, maximum_items: int, maximum_length: int) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise ValueError(f"{name} must be a bounded list")
    output = []
    for item in value:
        text = _text(item, name, maximum_length)
        if text not in output:
            output.append(text)
    return tuple(output)


def _canonical_directory(value, name: str) -> str:
    raw = _text(value, name, 4096)
    if not os.path.isabs(raw):
        raise ValueError(f"{name} must be absolute")
    canonical = os.path.realpath(raw)
    if not os.path.isdir(canonical):
        raise ValueError(f"{name} must be an existing canonical directory")
    return canonical


def _git_remote(value) -> Optional[str]:
    if value is None:
        return None
    remote = _text(value, "gitRemote", 500)
    try:
        parsed = urlsplit(remote)
    except ValueError as error:
        raise ValueError("gitRemote is invalid") from error
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("gitRemote must be a credential-free HTTPS URL")
    return remote


def _normalized(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).lower().split())


def _alias_present(text: str, alias: str) -> bool:
    raw_alias = unicodedata.normalize("NFKC", alias).strip()
    raw_text = unicodedata.normalize("NFKC", text)
    if not raw_alias:
        return False
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]*", raw_alias):
        pattern = (
            r"(?<![A-Za-z0-9_./-])"
            + re.escape(raw_alias).replace(r"\ ", r"\s+")
            + r"(?![A-Za-z0-9_./-])"
        )
        return re.search(pattern, raw_text, re.IGNORECASE) is not None
    return _normalized(raw_alias) in _normalized(raw_text)


@dataclass(frozen=True)
class DingTalkSource:
    id: str
    name: str
    kind: str
    node_id: str

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "kind": self.kind, "nodeId": self.node_id}


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    aliases: tuple[str, ...]
    root: str
    git_remote: Optional[str]
    gbrain_slugs: tuple[str, ...]
    run_instructions: str
    dingtalk_sources: tuple[DingTalkSource, ...]

    @property
    def routing_aliases(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((self.id, self.name, *self.aliases)))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "aliases": list(self.aliases),
            "root": self.root,
            "gitRemote": self.git_remote,
            "gbrainSlugs": list(self.gbrain_slugs),
            "runInstructions": self.run_instructions,
            "dingtalkSources": [source.to_dict() for source in self.dingtalk_sources],
        }


@dataclass(frozen=True)
class RouteResult:
    status: str
    project: Optional[Project]
    workspace_path: str
    candidates: tuple[Project, ...] = ()

    @property
    def context(self) -> str:
        if self.project:
            slugs = ", ".join(self.project.gbrain_slugs) or "none"
            return (
                f"Foursday project route: {self.project.name} ({self.project.id}).\n"
                f"Workspace: {self.project.root}\n"
                f"gbrain pages: {slugs}\n"
                f"Run instructions: {self.project.run_instructions or 'Read project instructions first.'}"
            )
        if self.status == "ambiguous":
            names = ", ".join(project.name for project in self.candidates)
            return f"Project routing is ambiguous. Ask the user to choose one of: {names}. Do not execute tools yet."
        return "No project was identified. Ask one concise project clarification before using work tools."


class ProjectRegistry:
    def __init__(
        self,
        projects: Iterable[Project],
        fallback_workspace: str,
        binding_path: Optional[str] = None,
    ):
        self.projects = tuple(projects)
        self.fallback_workspace = _canonical_directory(
            fallback_workspace,
            "fallback_workspace",
        )
        self.binding_path = None
        if binding_path:
            raw_binding_path = os.path.abspath(os.path.expanduser(binding_path))
            parent = os.path.realpath(os.path.dirname(raw_binding_path))
            if not os.path.isdir(parent):
                raise ValueError("Project route binding parent must exist")
            self.binding_path = os.path.join(parent, os.path.basename(raw_binding_path))
        self._bindings: dict[str, str] = self._load_bindings()
        self._lock = threading.RLock()

    @classmethod
    def load(
        cls,
        path: str,
        *,
        fallback_workspace: str,
        binding_path: Optional[str] = None,
    ) -> "ProjectRegistry":
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
        if (
            not isinstance(document, dict)
            or set(document) != {"schemaVersion", "projects"}
            or document.get("schemaVersion") != 1
            or not isinstance(document.get("projects"), list)
            or not document["projects"]
        ):
            raise ValueError("Project registry shape is invalid")
        projects = []
        ids = set()
        for raw in document["projects"]:
            if not isinstance(raw, dict) or not set(raw).issubset(_PROJECT_KEYS):
                raise ValueError("Project registry contains unsupported fields")
            if not {"id", "name", "aliases", "root"}.issubset(raw):
                raise ValueError("Project registry project is incomplete")
            project_id = _text(raw["id"], "project.id", 64)
            if not _PROJECT_ID.fullmatch(project_id) or project_id in ids:
                raise ValueError("Project registry id is invalid or duplicated")
            ids.add(project_id)
            gbrain_slugs = _text_list(
                raw.get("gbrainSlugs") or [],
                "project.gbrainSlugs",
                20,
                300,
            )
            if any(
                not _GBRAIN_SLUG.fullmatch(slug)
                or slug.startswith("/")
                or ".." in slug.split("/")
                for slug in gbrain_slugs
            ):
                raise ValueError("Project gbrain slug is invalid")
            raw_sources = raw.get("dingtalkSources") or []
            if not isinstance(raw_sources, list) or len(raw_sources) > 20:
                raise ValueError("Project DingTalk sources must be a bounded list")
            dingtalk_sources = []
            source_ids = set()
            for raw_source in raw_sources:
                if not isinstance(raw_source, dict) or set(raw_source) != {"id", "name", "kind", "nodeId"}:
                    raise ValueError("Project DingTalk source is invalid")
                source_id = _text(raw_source["id"], "project.dingtalkSources.id", 64)
                if not _PROJECT_ID.fullmatch(source_id) or source_id in source_ids:
                    raise ValueError("Project DingTalk source id is invalid or duplicated")
                source_ids.add(source_id)
                kind = _text(raw_source["kind"], "project.dingtalkSources.kind", 20)
                node_id = _text(raw_source["nodeId"], "project.dingtalkSources.nodeId", 80)
                if kind != "doc" or not _DINGTALK_NODE_ID.fullmatch(node_id):
                    raise ValueError("Project DingTalk source is invalid")
                dingtalk_sources.append(DingTalkSource(
                    id=source_id,
                    name=_text(raw_source["name"], "project.dingtalkSources.name", 200),
                    kind=kind,
                    node_id=node_id,
                ))
            projects.append(Project(
                id=project_id,
                name=_text(raw["name"], "project.name", 200),
                aliases=_text_list(raw["aliases"], "project.aliases", 30, 120),
                root=_canonical_directory(raw["root"], "project.root"),
                git_remote=_git_remote(raw.get("gitRemote")),
                gbrain_slugs=gbrain_slugs,
                run_instructions=str(raw.get("runInstructions") or "").strip()[:2000],
                dingtalk_sources=tuple(dingtalk_sources),
            ))
        return cls(projects, fallback_workspace, binding_path=binding_path)

    def _load_bindings(self) -> dict[str, str]:
        if not self.binding_path or not os.path.exists(self.binding_path):
            return {}
        metadata = os.stat(self.binding_path, follow_symlinks=False)
        if not stat_module.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise ValueError("Project route binding file must be private")
        with open(self.binding_path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
        if (
            not isinstance(document, dict)
            or set(document) != {"schemaVersion", "bindings"}
            or document.get("schemaVersion") != 1
            or not isinstance(document.get("bindings"), dict)
        ):
            raise ValueError("Project route binding file is invalid")
        valid_ids = {project.id for project in self.projects}
        output = {}
        for session_key, project_id in document["bindings"].items():
            if (
                not isinstance(session_key, str)
                or not session_key.strip()
                or len(session_key) > 500
                or project_id not in valid_ids
            ):
                raise ValueError("Project route binding is invalid")
            output[session_key] = project_id
        return output

    def _save_bindings(self) -> None:
        if not self.binding_path:
            return
        parent = os.path.dirname(self.binding_path)
        descriptor, temporary = tempfile.mkstemp(prefix=".routes-", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({
                    "schemaVersion": 1,
                    "bindings": self._bindings,
                }, handle, ensure_ascii=False, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.binding_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def route(self, *, text: str, session_key: str) -> RouteResult:
        original_text = str(text or "")
        matches = []
        for project in self.projects:
            aliases = [
                alias for alias in project.routing_aliases
                if _alias_present(original_text, alias)
            ]
            if aliases:
                matches.append((project, max(len(_normalized(alias)) for alias in aliases)))
        if matches:
            longest = max(length for _project, length in matches)
            strongest = [project for project, length in matches if length == longest]
            if len(strongest) == 1:
                project = strongest[0]
                with self._lock:
                    self._bindings[session_key] = project.id
                    self._save_bindings()
                return RouteResult("matched", project, project.root)
            return RouteResult(
                "ambiguous",
                None,
                self.fallback_workspace,
                tuple(strongest),
            )
        with self._lock:
            bound_id = self._bindings.get(session_key)
        if bound_id:
            project = next((item for item in self.projects if item.id == bound_id), None)
            if project:
                return RouteResult("bound", project, project.root)
        return RouteResult("unmatched", None, self.fallback_workspace)

    def clear_binding(self, session_key: str) -> None:
        with self._lock:
            self._bindings.pop(session_key, None)
            self._save_bindings()
