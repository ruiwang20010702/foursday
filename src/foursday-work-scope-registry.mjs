import { isAbsolute } from "node:path";

const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const slugPattern = /^[\p{L}\p{N}._/-]{1,300}$/u;
const legacyProjectKeys = new Set([
  "id", "name", "aliases", "root", "gitRemote", "gbrainSlugs",
  "runInstructions", "dingtalkSources",
]);

function text(value, label, maximum) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}

function textList(value, label, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} must be a bounded list`);
  }
  return [...new Set(value.map((item) => text(item, label, maximumLength)))];
}

function validateSlug(value) {
  const slug = text(value, "gbrain slug", 300);
  if (
    !slugPattern.test(slug) || slug.startsWith("/") || slug.includes("//") ||
    slug.split("/").includes("..")
  ) throw new Error("gbrain slug is invalid");
  return slug;
}

function validateIdentifier(value, label) {
  const id = text(value, label, 64);
  if (!identifier.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function credentialFreeRemote(value) {
  if (value == null) return null;
  const remote = text(value, "workspace.gitRemote", 500);
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error("workspace.gitRemote is invalid");
  }
  if (
    parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) throw new Error("workspace.gitRemote must be credential-free HTTPS");
  return remote;
}

function dingtalkSources(value) {
  const sources = value ?? [];
  if (!Array.isArray(sources) || sources.length > 20) {
    throw new Error("scope.dingtalkSources must be a bounded list");
  }
  const ids = new Set();
  return sources.map((source) => {
    if (
      !source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).some((key) => !["id", "name", "kind", "nodeId"].includes(key))
    ) throw new Error("scope.dingtalkSources is invalid");
    const id = validateIdentifier(source.id, "scope.dingtalkSources.id");
    const nodeId = text(source.nodeId, "scope.dingtalkSources.nodeId", 80);
    if (
      id.startsWith("provided_") || ids.has(id) || source.kind !== "doc" ||
      !/^[A-Za-z0-9]{20,80}$/u.test(nodeId)
    ) throw new Error("scope.dingtalkSources is invalid");
    ids.add(id);
    return {
      id,
      name: text(source.name, "scope.dingtalkSources.name", 200),
      kind: "doc",
      nodeId,
    };
  });
}

function legacyRegistry(document) {
  if (Object.keys(document).some((key) => !["schemaVersion", "projects"].includes(key))) {
    throw new Error("Foursday project registry is invalid");
  }
  if (!Array.isArray(document.projects) || document.projects.length > 1_000) {
    throw new Error("Foursday project registry is invalid");
  }
  return {
    sourceSchemaVersion: 1,
    workspaces: document.projects.map((project) => {
      if (
        !project || typeof project !== "object" || Array.isArray(project) ||
        Object.keys(project).some((key) => !legacyProjectKeys.has(key)) ||
        !["id", "name", "aliases", "root"].every((key) => key in project)
      ) throw new Error("Foursday project registry is invalid");
      const root = text(project.root, "project.root", 4_096);
      if (!isAbsolute(root)) throw new Error("project.root must be absolute");
      return {
        id: validateIdentifier(project.id, "project.id"),
        root,
        gitRemote: credentialFreeRemote(project?.gitRemote),
        runInstructions: String(project?.runInstructions ?? "").trim().slice(0, 2_000),
      };
    }),
    scopes: document.projects.map((project) => ({
      id: validateIdentifier(project?.id, "project.id"),
      name: text(project?.name, "project.name", 200),
      aliases: textList(project?.aliases ?? [], "project.aliases", 30, 120),
      parentId: null,
      workspaceId: validateIdentifier(project?.id, "project.id"),
      gbrainSlugs: textList(project?.gbrainSlugs ?? [], "project.gbrainSlugs", 20, 300)
        .map(validateSlug),
      dingtalkSources: dingtalkSources(project?.dingtalkSources),
    })),
  };
}

function versionTwoRegistry(document) {
  if (Object.keys(document).some((key) => !["schemaVersion", "workspaces", "scopes"].includes(key))) {
    throw new Error("Foursday work-scope registry is invalid");
  }
  if (
    !Array.isArray(document.workspaces) || document.workspaces.length > 1_000 ||
    !Array.isArray(document.scopes) || document.scopes.length > 2_000
  ) throw new Error("Foursday work-scope registry is invalid");
  const workspaces = document.workspaces.map((workspace) => {
    if (
      !workspace || typeof workspace !== "object" || Array.isArray(workspace) ||
      Object.keys(workspace).some((key) => !["id", "root", "gitRemote", "runInstructions"].includes(key))
    ) throw new Error("Foursday workspace registry is invalid");
    const root = text(workspace.root, "workspace.root", 4_096);
    if (!isAbsolute(root)) throw new Error("workspace.root must be absolute");
    return {
      id: validateIdentifier(workspace.id, "workspace.id"),
      root,
      gitRemote: credentialFreeRemote(workspace.gitRemote),
      runInstructions: String(workspace.runInstructions ?? "").trim().slice(0, 2_000),
    };
  });
  if (new Set(workspaces.map((item) => item.id)).size !== workspaces.length) {
    throw new Error("Foursday workspace id is duplicated");
  }
  const workspaceIds = new Set(workspaces.map((item) => item.id));
  const scopes = document.scopes.map((scope) => {
    if (
      !scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).some((key) => ![
        "id", "name", "aliases", "parentId", "workspaceId", "gbrainSlugs", "dingtalkSources",
      ].includes(key))
    ) throw new Error("Foursday work scope is invalid");
    const workspaceId = scope.workspaceId == null
      ? null
      : validateIdentifier(scope.workspaceId, "scope.workspaceId");
    if (workspaceId && !workspaceIds.has(workspaceId)) {
      throw new Error("Foursday work scope references an unknown workspace");
    }
    return {
      id: validateIdentifier(scope.id, "scope.id"),
      name: text(scope.name, "scope.name", 200),
      aliases: textList(scope.aliases ?? [], "scope.aliases", 30, 120),
      parentId: scope.parentId == null ? null : validateIdentifier(scope.parentId, "scope.parentId"),
      workspaceId,
      gbrainSlugs: textList(scope.gbrainSlugs ?? [], "scope.gbrainSlugs", 20, 300).map(validateSlug),
      dingtalkSources: dingtalkSources(scope.dingtalkSources),
    };
  });
  if (new Set(scopes.map((item) => item.id)).size !== scopes.length) {
    throw new Error("Foursday work scope id is duplicated");
  }
  return { sourceSchemaVersion: 2, workspaces, scopes };
}

export function normalizeWorkScopeRegistry(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Foursday work-scope registry is invalid");
  }
  const normalized = document.schemaVersion === 1
    ? legacyRegistry(document)
    : document.schemaVersion === 2
      ? versionTwoRegistry(document)
      : null;
  if (!normalized) throw new Error("Foursday work-scope registry version is unsupported");

  const workspaces = new Map(normalized.workspaces.map((item) => [item.id, item]));
  const scopes = new Map(normalized.scopes.map((item) => [item.id, item]));
  if (workspaces.size !== normalized.workspaces.length || scopes.size !== normalized.scopes.length) {
    throw new Error("Foursday work-scope registry contains duplicated ids");
  }
  const resolved = new Map();
  const resolving = new Set();
  const resolveScope = (scopeId) => {
    if (resolved.has(scopeId)) return resolved.get(scopeId);
    if (resolving.has(scopeId)) throw new Error("Foursday work scope parent cycle detected");
    const scope = scopes.get(scopeId);
    if (!scope) throw new Error("Foursday work scope parent is unknown");
    resolving.add(scopeId);
    const parent = scope.parentId ? resolveScope(scope.parentId) : null;
    const workspaceId = scope.workspaceId ?? parent?.workspaceId ?? null;
    if (!workspaceId || !workspaces.has(workspaceId)) {
      throw new Error("Foursday work scope has no executable workspace");
    }
    const lineage = [...(parent?.lineage ?? []), scope.id];
    const gbrainSlugs = [...new Set([...(parent?.gbrainSlugs ?? []), ...scope.gbrainSlugs])];
    const inheritedSources = [...(parent?.dingtalkSources ?? []), ...scope.dingtalkSources];
    if (gbrainSlugs.length > 32) throw new Error("Foursday inherited gbrain scope is too broad");
    if (
      inheritedSources.length > 20 ||
      new Set(inheritedSources.map((item) => item.id)).size !== inheritedSources.length
    ) {
      throw new Error("Foursday inherited DingTalk source scope is invalid or too broad");
    }
    const value = {
      ...scope,
      workspaceId,
      workspace: workspaces.get(workspaceId),
      lineage,
      gbrainSlugs,
      dingtalkSources: inheritedSources,
    };
    resolving.delete(scopeId);
    resolved.set(scopeId, value);
    return value;
  };
  for (const scope of normalized.scopes) resolveScope(scope.id);
  return {
    schemaVersion: 2,
    sourceSchemaVersion: normalized.sourceSchemaVersion,
    workspaces: [...workspaces.values()],
    scopes: [...resolved.values()],
  };
}

export function legacyProjectsFromWorkScopes(document) {
  return normalizeWorkScopeRegistry(document).scopes.map((scope) => ({
    id: scope.id,
    name: scope.name,
    aliases: scope.aliases,
    root: scope.workspace.root,
    gitRemote: scope.workspace.gitRemote,
    gbrainSlugs: scope.gbrainSlugs,
    dingtalkSources: scope.dingtalkSources,
    runInstructions: scope.workspace.runInstructions,
    parentId: scope.parentId,
    workspaceId: scope.workspaceId,
    lineage: scope.lineage,
  }));
}
