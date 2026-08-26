"""Project identity registry with conversation-scoped workspace routing."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
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


def _binding_key(session_key: str) -> str:
    value = _text(session_key, "session_key", 500)
    if re.fullmatch(r"[a-f0-9]{64}", value):
        return value
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


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
    parent_id: Optional[str] = None
    workspace_id: Optional[str] = None
    lineage: tuple[str, ...] = ()

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
            "parentId": self.parent_id,
            "workspaceId": self.workspace_id or self.id,
            "lineage": list(self.lineage or (self.id,)),
        }


@dataclass(frozen=True)
class RouteResult:
    status: str
    project: Optional[Project]
    workspace_path: str
    candidates: tuple[Project, ...] = ()
    related_projects: tuple[Project, ...] = ()
    related_gbrain_slugs: tuple[str, ...] = ()
    selection_rationale: str = ""

    @property
    def context(self) -> str:
        if self.project:
            slugs = ", ".join(self.project.gbrain_slugs) or "none"
            related = ", ".join(
                project.name for project in self.related_projects
            ) or "none"
            related_memory = ", ".join(self.related_gbrain_slugs) or "none"
            return (
                f"Foursday primary work scope: {self.project.name} ({self.project.id}).\n"
                f"Scope lineage: {' > '.join(self.project.lineage or (self.project.id,))}\n"
                f"Related executable scopes: {related}\n"
                f"Related gbrain project pages: {related_memory}\n"
                f"Workspace: {self.project.root}\n"
                f"gbrain pages: {slugs}\n"
                f"Run instructions: {self.project.run_instructions or 'Read project instructions first.'}"
            )
        if self.status == "ambiguous":
            names = ", ".join(project.name for project in self.candidates)
            return (
                f"Several executable work scopes may fit: {names}. Use the request, prior Thread, "
                "current sources and personal gbrain to choose the most useful primary scope. "
                "Ask a person only when unresolved business meaning would materially change the result."
            )
        return (
            "No executable work scope is bound yet. Discover candidate scopes from the request, "
            "current sources, prior Thread and personal gbrain; let Codex choose, and ask a person "
            "only for irreducible business meaning."
        )


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
        self._bindings: dict[str, dict] = self._load_bindings()
        self._lock = threading.RLock()

    @staticmethod
    def _version_two_projects(document: dict) -> list[Project]:
        if set(document) != {"schemaVersion", "workspaces", "scopes"}:
            raise ValueError("Work-scope registry shape is invalid")
        raw_workspaces = document.get("workspaces")
        raw_scopes = document.get("scopes")
        if (
            not isinstance(raw_workspaces, list) or not 0 < len(raw_workspaces) <= 1000
            or not isinstance(raw_scopes, list) or not 0 < len(raw_scopes) <= 2000
        ):
            raise ValueError("Work-scope registry is invalid")
        workspaces: dict[str, dict] = {}
        for raw in raw_workspaces:
            if (
                not isinstance(raw, dict)
                or not set(raw).issubset({"id", "root", "gitRemote", "runInstructions"})
                or not {"id", "root"}.issubset(raw)
            ):
                raise ValueError("Workspace registry is invalid")
            workspace_id = _text(raw["id"], "workspace.id", 64)
            if not _PROJECT_ID.fullmatch(workspace_id) or workspace_id in workspaces:
                raise ValueError("Workspace id is invalid or duplicated")
            workspaces[workspace_id] = {
                "root": _canonical_directory(raw["root"], "workspace.root"),
                "git_remote": _git_remote(raw.get("gitRemote")),
                "run_instructions": str(raw.get("runInstructions") or "").strip()[:2000],
            }
        scopes: dict[str, dict] = {}
        for raw in raw_scopes:
            if (
                not isinstance(raw, dict)
                or not set(raw).issubset({
                    "id", "name", "aliases", "parentId", "workspaceId",
                    "gbrainSlugs", "dingtalkSources",
                })
                or not {"id", "name", "aliases"}.issubset(raw)
            ):
                raise ValueError("Work scope is invalid")
            scope_id = _text(raw["id"], "scope.id", 64)
            if not _PROJECT_ID.fullmatch(scope_id) or scope_id in scopes:
                raise ValueError("Work scope id is invalid or duplicated")
            parent_id = raw.get("parentId")
            if parent_id is not None:
                parent_id = _text(parent_id, "scope.parentId", 64)
                if not _PROJECT_ID.fullmatch(parent_id):
                    raise ValueError("Work scope parent is invalid")
            workspace_id = raw.get("workspaceId")
            if workspace_id is not None:
                workspace_id = _text(workspace_id, "scope.workspaceId", 64)
                if workspace_id not in workspaces:
                    raise ValueError("Work scope workspace is invalid")
            gbrain_slugs = _text_list(
                raw.get("gbrainSlugs") or [], "scope.gbrainSlugs", 20, 300,
            )
            if any(
                not _GBRAIN_SLUG.fullmatch(slug) or slug.startswith("/")
                or ".." in slug.split("/") for slug in gbrain_slugs
            ):
                raise ValueError("Work scope gbrain slug is invalid")
            raw_sources = raw.get("dingtalkSources") or []
            if not isinstance(raw_sources, list) or len(raw_sources) > 20:
                raise ValueError("Work scope DingTalk sources must be bounded")
            source_ids = set()
            sources = []
            for source in raw_sources:
                if not isinstance(source, dict) or set(source) != {"id", "name", "kind", "nodeId"}:
                    raise ValueError("Work scope DingTalk source is invalid")
                source_id = _text(source["id"], "scope.dingtalkSources.id", 64)
                node_id = _text(source["nodeId"], "scope.dingtalkSources.nodeId", 80)
                if (
                    not _PROJECT_ID.fullmatch(source_id) or source_id.startswith("provided_")
                    or source_id in source_ids or source.get("kind") != "doc"
                    or not _DINGTALK_NODE_ID.fullmatch(node_id)
                ):
                    raise ValueError("Work scope DingTalk source is invalid")
                source_ids.add(source_id)
                sources.append(DingTalkSource(
                    id=source_id,
                    name=_text(source["name"], "scope.dingtalkSources.name", 200),
                    kind="doc",
                    node_id=node_id,
                ))
            scopes[scope_id] = {
                "name": _text(raw["name"], "scope.name", 200),
                "aliases": _text_list(raw["aliases"], "scope.aliases", 30, 120),
                "parent_id": parent_id,
                "workspace_id": workspace_id,
                "gbrain_slugs": gbrain_slugs,
                "dingtalk_sources": tuple(sources),
            }
        resolved: dict[str, Project] = {}
        resolving = set()

        def resolve_scope(scope_id: str) -> Project:
            if scope_id in resolved:
                return resolved[scope_id]
            if scope_id in resolving or scope_id not in scopes:
                raise ValueError("Work scope parent cycle or missing parent")
            resolving.add(scope_id)
            raw = scopes[scope_id]
            parent = resolve_scope(raw["parent_id"]) if raw["parent_id"] else None
            workspace_id = raw["workspace_id"] or (parent.workspace_id if parent else None)
            if not workspace_id or workspace_id not in workspaces:
                raise ValueError("Work scope has no executable workspace")
            workspace = workspaces[workspace_id]
            sources = (*((parent.dingtalk_sources if parent else ())), *raw["dingtalk_sources"])
            if len(sources) > 20 or len({source.id for source in sources}) != len(sources):
                raise ValueError("Inherited DingTalk source scope is invalid or too broad")
            slugs = tuple(dict.fromkeys((
                *((parent.gbrain_slugs if parent else ())), *raw["gbrain_slugs"],
            )))
            if len(slugs) > 32:
                raise ValueError("Inherited gbrain scope is too broad")
            project = Project(
                id=scope_id,
                name=raw["name"],
                aliases=raw["aliases"],
                root=workspace["root"],
                git_remote=workspace["git_remote"],
                gbrain_slugs=slugs,
                run_instructions=workspace["run_instructions"],
                dingtalk_sources=tuple(sources),
                parent_id=raw["parent_id"],
                workspace_id=workspace_id,
                lineage=(*((parent.lineage if parent else ())), scope_id),
            )
            resolving.remove(scope_id)
            resolved[scope_id] = project
            return project

        return [resolve_scope(scope_id) for scope_id in scopes]

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
        if isinstance(document, dict) and document.get("schemaVersion") == 2:
            return cls(
                cls._version_two_projects(document),
                fallback_workspace,
                binding_path=binding_path,
            )
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
                if (
                    not _PROJECT_ID.fullmatch(source_id)
                    or source_id.startswith("provided_")
                    or source_id in source_ids
                ):
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
                workspace_id=project_id,
                lineage=(project_id,),
            ))
        return cls(projects, fallback_workspace, binding_path=binding_path)

    def _load_bindings(self) -> dict[str, dict]:
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
            or document.get("schemaVersion") not in {1, 2}
            or not isinstance(document.get("bindings"), dict)
        ):
            raise ValueError("Project route binding file is invalid")
        valid_ids = {project.id for project in self.projects}
        output = {}
        for session_key, raw in document["bindings"].items():
            if not isinstance(session_key, str) or not session_key.strip() or len(session_key) > 500:
                raise ValueError("Project route binding is invalid")
            if document["schemaVersion"] == 1:
                raw = {
                    "primaryScopeId": raw,
                    "relatedScopeIds": [],
                    "relatedGbrainSlugs": [],
                    "evidenceSourceIds": [],
                    "rationale": "Migrated legacy project binding.",
                }
            if not isinstance(raw, dict):
                raise ValueError("Project route binding is invalid")
            if not set(raw).issubset({
                "primaryScopeId", "relatedScopeIds", "relatedGbrainSlugs",
                "evidenceSourceIds", "rationale", "updatedAt",
            }):
                raise ValueError("Project route binding is invalid")
            primary = raw.get("primaryScopeId")
            related = raw.get("relatedScopeIds") or []
            related_memory = raw.get("relatedGbrainSlugs") or []
            evidence = raw.get("evidenceSourceIds") or []
            rationale = str(raw.get("rationale") or "")[:500]
            if (
                primary not in valid_ids
                or not isinstance(related, list) or len(related) > 8
                or any(value not in valid_ids for value in related)
                or primary in related
                or not isinstance(related_memory, list) or len(related_memory) > 12
                or any(
                    not isinstance(slug, str) or not slug.startswith("projects/")
                    or not _GBRAIN_SLUG.fullmatch(slug) or "//" in slug
                    or ".." in slug.split("/") for slug in related_memory
                )
                or not isinstance(evidence, list) or len(evidence) > 4
                or any(not re.fullmatch(r"provided_[1-4]", str(value)) for value in evidence)
                or any(ord(char) < 32 or ord(char) == 127 for char in rationale)
                or (
                    raw.get("updatedAt") is not None
                    and (not isinstance(raw.get("updatedAt"), str) or len(raw["updatedAt"]) > 64)
                )
            ):
                raise ValueError("Project route binding is invalid")
            output[_binding_key(session_key)] = {
                "primaryScopeId": primary,
                "relatedScopeIds": list(dict.fromkeys(related)),
                "relatedGbrainSlugs": list(dict.fromkeys(related_memory)),
                "evidenceSourceIds": list(dict.fromkeys(evidence)),
                "rationale": rationale,
                "updatedAt": raw.get("updatedAt"),
            }
        return output

    def _save_bindings(self) -> None:
        if not self.binding_path:
            return
        parent = os.path.dirname(self.binding_path)
        descriptor, temporary = tempfile.mkstemp(prefix=".routes-", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({
                    "schemaVersion": 2,
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
                    if self.binding_path:
                        self._bindings = self._load_bindings()
                    self._bindings[_binding_key(session_key)] = {
                        "primaryScopeId": project.id,
                        "relatedScopeIds": [],
                        "relatedGbrainSlugs": [],
                        "evidenceSourceIds": [],
                        "rationale": "Explicit project or work-scope name in the current request.",
                        "updatedAt": None,
                    }
                    self._save_bindings()
                return RouteResult("matched", project, project.root)
            return RouteResult(
                "ambiguous",
                None,
                self.fallback_workspace,
                tuple(strongest),
            )
        with self._lock:
            if self.binding_path:
                self._bindings = self._load_bindings()
            binding = self._bindings.get(_binding_key(session_key))
        if binding:
            project = next(
                (item for item in self.projects if item.id == binding["primaryScopeId"]),
                None,
            )
            if project:
                related = tuple(
                    item for scope_id in binding["relatedScopeIds"]
                    for item in self.projects if item.id == scope_id
                )
                return RouteResult(
                    "bound", project, project.root,
                    related_projects=related,
                    related_gbrain_slugs=tuple(binding["relatedGbrainSlugs"]),
                    selection_rationale=binding["rationale"],
                )
        return RouteResult("unmatched", None, self.fallback_workspace)

    def clear_binding(self, session_key: str) -> None:
        with self._lock:
            if self.binding_path:
                self._bindings = self._load_bindings()
            self._bindings.pop(_binding_key(session_key), None)
            self._save_bindings()

    def bound_selection(self, session_key: str) -> Optional[dict]:
        with self._lock:
            if self.binding_path:
                self._bindings = self._load_bindings()
            binding = self._bindings.get(_binding_key(session_key))
        return dict(binding) if binding else None
