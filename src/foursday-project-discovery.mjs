import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { normalizeWorkScopeRegistry } from "./foursday-work-scope-registry.mjs";

const execFileAsync = promisify(execFile);
const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const catalogKeys = new Set([
  "projectId", "projectKind", "label", "path", "hostId", "hostDisplayName",
  "isGitRepository",
]);
const sensitiveHomeRoots = new Set([
  ".aws", ".codex", ".config", ".gnupg", ".hermes", ".ssh",
  "Applications", "Library",
]);
const broadHomeRoots = new Set([
  "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", "Public",
]);

function normalizedMatch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "");
}

function stableSuffix(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function identifierBase(value, fallback) {
  const ascii = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 48);
  return ascii && /^[a-z0-9]/u.test(ascii) ? ascii : fallback;
}

function uniqueIdentifier(base, seed, used) {
  const fallback = `project_${stableSuffix(seed)}`;
  const normalized = identifierBase(base, fallback);
  let candidate = normalized.slice(0, 64);
  if (!identifier.test(candidate)) candidate = fallback;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  candidate = `${normalized.slice(0, 52)}_${stableSuffix(seed)}`.slice(0, 64);
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${normalized.slice(0, 49)}_${stableSuffix(seed)}_${counter}`.slice(0, 64);
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function safeRemote(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let candidate = text;
  const ssh = /^git@([^:]+):(.+)$/u.exec(text);
  if (ssh) candidate = `https://${ssh[1]}/${ssh[2]}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  if (
    parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) return null;
  return parsed.toString().replace(/\/$/u, "");
}

async function gitRemote(root, run = execFileAsync) {
  try {
    const result = await run("/usr/bin/git", ["-C", root, "config", "--get", "remote.origin.url"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return safeRemote(result.stdout);
  } catch {
    return null;
  }
}

function catalogProjects(document) {
  if (
    !document || typeof document !== "object" || Array.isArray(document) ||
    document.schemaVersion !== 2 || !Array.isArray(document.projects) ||
    document.projects.length > 1_000
  ) throw new Error("Foursday Codex project catalog is invalid");
  return document.projects.map((project) => {
    if (
      !project || typeof project !== "object" || Array.isArray(project) ||
      Object.keys(project).some((key) => !catalogKeys.has(key)) ||
      typeof project.label !== "string" || !project.label.trim() ||
      typeof project.path !== "string" || !isAbsolute(project.path) ||
      (project.projectKind != null && project.projectKind !== "local")
    ) throw new Error("Foursday Codex project entry is invalid");
    return {
      name: project.label.trim().slice(0, 200),
      root: project.path,
      isGitRepository: project.isGitRepository === true,
    };
  });
}

async function canonicalCatalogProjects(document, { userHome }) {
  const canonicalHome = await realpath(userHome);
  const included = [];
  const excluded = [];
  const seen = new Set();
  for (const project of catalogProjects(document)) {
    let metadata;
    try { metadata = await lstat(project.root); } catch {
      excluded.push({ name: project.name, reason: "missing" });
      continue;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      excluded.push({ name: project.name, reason: "unsafe" });
      continue;
    }
    const root = await realpath(project.root);
    const fromHome = relative(canonicalHome, root);
    const segments = fromHome.split(sep).filter(Boolean);
    if (
      root === canonicalHome || !fromHome || fromHome.startsWith(`..${sep}`) ||
      fromHome === ".." || isAbsolute(fromHome) || sensitiveHomeRoots.has(segments[0]) ||
      (segments.length === 1 && broadHomeRoots.has(segments[0]))
    ) {
      excluded.push({ name: project.name, reason: "too_broad_or_outside_home" });
      continue;
    }
    if (seen.has(root)) {
      excluded.push({ name: project.name, reason: "duplicate" });
      continue;
    }
    seen.add(root);
    included.push({ ...project, root });
  }
  return { included, excluded };
}

function memorySlugsFor(project, gbrainProjects) {
  const names = new Set([
    normalizedMatch(project.name),
    normalizedMatch(project.root.split(sep).at(-1)),
  ].filter(Boolean));
  const matches = gbrainProjects.filter((page) => {
    const slugName = String(page.slug ?? "").split("/").at(-1);
    return [page.title, slugName].some((value) => names.has(normalizedMatch(value)));
  }).map((page) => page.slug);
  return matches.length === 1 ? matches : [];
}

function nearestParent(project, projects) {
  const ancestors = projects.filter((candidate) =>
    candidate.root !== project.root && relative(candidate.root, project.root) &&
    !relative(candidate.root, project.root).startsWith(`..${sep}`) &&
    relative(candidate.root, project.root) !== ".." &&
    !isAbsolute(relative(candidate.root, project.root))
  );
  return ancestors.sort((left, right) => right.root.length - left.root.length)[0] ?? null;
}

export async function discoverFoursdayProjectRegistry({
  catalog,
  existingRegistry = { schemaVersion: 2, workspaces: [], scopes: [] },
  gbrainProjects = [],
  userHome,
  run = execFileAsync,
} = {}) {
  if (!userHome || !isAbsolute(userHome)) throw new Error("Foursday discovery user home is invalid");
  if (!Array.isArray(gbrainProjects) || gbrainProjects.length > 1_000) {
    throw new Error("Foursday gbrain project catalog is invalid");
  }
  const existing = normalizeWorkScopeRegistry(existingRegistry);
  const canonical = await canonicalCatalogProjects(catalog, { userHome });
  const existingWorkspaceByRoot = new Map(existing.workspaces.map((workspace) => [workspace.root, workspace]));
  const existingScopeByWorkspace = new Map();
  for (const scope of existing.scopes) {
    if (!existingScopeByWorkspace.has(scope.workspaceId)) {
      existingScopeByWorkspace.set(scope.workspaceId, scope);
    }
  }
  const usedWorkspaceIds = new Set(existing.workspaces.map((workspace) => workspace.id));
  const usedScopeIds = new Set(existing.scopes.map((scope) => scope.id));
  const discovered = [];
  for (const project of canonical.included) {
    const preservedWorkspace = existingWorkspaceByRoot.get(project.root);
    const preservedScope = preservedWorkspace
      ? existingScopeByWorkspace.get(preservedWorkspace.id)
      : null;
    const workspaceId = preservedWorkspace?.id ?? uniqueIdentifier(
      project.name,
      `workspace:${project.root}`,
      usedWorkspaceIds,
    );
    const scopeId = preservedScope?.id ?? (
      usedScopeIds.has(workspaceId)
        ? uniqueIdentifier(project.name, `scope:${project.root}`, usedScopeIds)
        : (usedScopeIds.add(workspaceId), workspaceId)
    );
    discovered.push({
      ...project,
      workspaceId,
      scopeId,
      preservedWorkspace,
      preservedScope,
    });
  }
  const workspaces = discovered.map((project) => ({
    id: project.workspaceId,
    root: project.root,
    gitRemote: project.preservedWorkspace?.gitRemote ?? null,
    runInstructions: project.preservedWorkspace?.runInstructions ?? (
      project.isGitRepository
        ? "Read project instructions and current evidence before acting; keep changes Git-visible."
        : "Treat this non-Git workspace as read-only unless the task explicitly authorizes a recoverable change with an undo copy."
    ),
  }));
  for (const workspace of workspaces) {
    if (!workspace.gitRemote) workspace.gitRemote = await gitRemote(workspace.root, run);
  }
  const discoveredRoots = new Set(discovered.map((project) => project.root));
  for (const workspace of existing.workspaces) {
    if (!discoveredRoots.has(workspace.root)) workspaces.push({ ...workspace });
  }
  const scopes = discovered.map((project) => {
    const parent = nearestParent(project, discovered);
    const preserved = project.preservedScope;
    const exactSlugs = memorySlugsFor(project, gbrainProjects);
    return {
      id: project.scopeId,
      name: preserved?.name ?? project.name,
      aliases: [...new Set([
        ...(preserved?.aliases ?? []),
        project.name,
        project.root.split(sep).at(-1),
      ].filter((value) => value && value !== (preserved?.name ?? project.name)))].slice(0, 30),
      parentId: preserved?.parentId ?? parent?.scopeId ?? null,
      workspaceId: project.workspaceId,
      gbrainSlugs: [...new Set([...(preserved?.gbrainSlugs ?? []), ...exactSlugs])].slice(0, 20),
      dingtalkSources: preserved?.dingtalkSources ?? [],
    };
  });
  const discoveredScopeIds = new Set(scopes.map((scope) => scope.id));
  for (const scope of existing.scopes) {
    if (discoveredScopeIds.has(scope.id)) continue;
    scopes.push({
      id: scope.id,
      name: scope.name,
      aliases: scope.aliases,
      parentId: scope.parentId,
      workspaceId: scope.workspaceId,
      gbrainSlugs: scope.gbrainSlugs,
      dingtalkSources: scope.dingtalkSources,
    });
  }
  const registry = { schemaVersion: 2, workspaces, scopes };
  normalizeWorkScopeRegistry(registry);
  return {
    registry,
    summary: {
      sourceProjects: catalog.projects.length,
      includedProjects: discovered.length,
      excludedProjects: canonical.excluded.length,
      preservedProjects: discovered.filter((project) => project.preservedWorkspace).length,
      retainedProjects: scopes.length - discovered.length,
      addedProjects: discovered.filter((project) => !project.preservedWorkspace).length,
      parentedScopes: scopes.filter((scope) => scope.parentId).length,
      fixedMemoryPages: new Set(scopes.flatMap((scope) => scope.gbrainSlugs)).size,
      excluded: canonical.excluded,
      projects: scopes.map((scope) => ({
        id: scope.id,
        name: scope.name,
        parentId: scope.parentId,
        fixedPageCount: scope.gbrainSlugs.length,
      })),
    },
  };
}
