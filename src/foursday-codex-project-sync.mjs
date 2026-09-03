import { constants } from "node:fs";
import { chmod, lstat, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { discoverFoursdayProjectRegistry } from "./foursday-project-discovery.mjs";
import { readCodexProjectCatalog } from "./foursday-codex-project-catalog.mjs";
import { normalizeWorkScopeRegistry } from "./foursday-work-scope-registry.mjs";
import { withDwsCommandLock } from "./dws-command-lock.mjs";

async function readPrivateRegistry(path) {
  if (!path || !isAbsolute(path)) throw new Error("project_registry_sync_unavailable");
  const absolute = resolve(path);
  if (await realpath(absolute).catch(() => null) !== absolute) {
    throw new Error("project_registry_sync_unavailable");
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 2 * 1024 * 1024 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("project_registry_sync_unavailable");
    const raw = JSON.parse(await handle.readFile("utf8"));
    return { raw, normalized: normalizeWorkScopeRegistry(raw) };
  } finally { await handle.close(); }
}

async function writePrivateJson(path, value) {
  const destination = resolve(path);
  const parent = dirname(destination);
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o077) !== 0 || await realpath(parent) !== parent ||
    (typeof process.getuid === "function" && parentMetadata.uid !== process.getuid())
  ) throw new Error("project_registry_sync_unavailable");
  const temporary = join(parent, `.foursday-project-sync-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

function externalRegistry(snapshot) {
  if (snapshot?.raw?.schemaVersion === 2) {
    return JSON.parse(JSON.stringify(snapshot.raw));
  }
  const normalized = snapshot?.normalized ?? snapshot;
  return {
    schemaVersion: 2,
    workspaces: normalized.workspaces.map((workspace) => ({ ...workspace })),
    scopes: normalized.scopes.map((scope) => ({
      id: scope.id,
      name: scope.name,
      aliases: [...scope.aliases],
      parentId: scope.parentId,
      workspaceId: scope.workspaceId,
      gbrainSlugs: [...scope.gbrainSlugs],
      dingtalkSources: scope.dingtalkSources.map((source) => ({ ...source })),
    })),
  };
}

export async function syncFoursdayCodexProjects({
  registryPath,
  codexStatePath,
  userHome,
  gbrainProjects = [],
  apply = false,
  run,
} = {}) {
  if (!isAbsolute(String(codexStatePath ?? "")) || !isAbsolute(String(userHome ?? ""))) {
    throw new Error("project_registry_sync_unavailable");
  }
  const synchronize = async () => {
    const current = await readPrivateRegistry(registryPath);
    const catalog = await readCodexProjectCatalog({ userHome, statePath: codexStatePath });
    const discovered = await discoverFoursdayProjectRegistry({
      catalog,
      existingRegistry: externalRegistry(current),
      gbrainProjects,
      userHome,
      ...(run ? { run } : {}),
    });
    const before = externalRegistry(current);
    const changed = JSON.stringify(before) !== JSON.stringify(discovered.registry);
    const result = {
      schema: "foursday-codex-project-sync/v1",
      apply,
      changed,
      sourceProjectCount: catalog.projects.length,
      addedProjectCount: discovered.summary.addedProjects,
      retainedProjectCount: discovered.summary.retainedProjects,
      excludedProjectCount: discovered.summary.excludedProjects,
      activeProjectCount: discovered.registry.scopes.length,
      fixedMemoryPageCount: discovered.summary.fixedMemoryPages,
      productionWrite: false,
      messagesSent: 0,
    };
    if (!apply || !changed) return result;
    const backupPath = `${resolve(registryPath)}.before-codex-sync`;
    await writePrivateJson(backupPath, before);
    try {
      await writePrivateJson(registryPath, discovered.registry);
      const verified = await readPrivateRegistry(registryPath);
      if (JSON.stringify(externalRegistry(verified)) !== JSON.stringify(discovered.registry)) {
        throw new Error("project_registry_sync_readback_failed");
      }
    } catch (error) {
      await writePrivateJson(registryPath, before);
      throw error;
    }
    return { ...result, productionWrite: true, backupCreated: true, readbackVerified: true };
  };
  return apply
    ? withDwsCommandLock(`${resolve(registryPath)}.sync-lock`, synchronize, { timeoutMs: 2_000 })
    : synchronize();
}
