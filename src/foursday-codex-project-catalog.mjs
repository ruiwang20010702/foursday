import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

async function readCodexState(path) {
  if (!path || !isAbsolute(path)) throw new Error("codex_project_catalog_unavailable");
  const absolute = resolve(path);
  if (await realpath(absolute).catch(() => null) !== absolute) {
    throw new Error("codex_project_catalog_unavailable");
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o022) !== 0 || metadata.size > 8 * 1024 * 1024 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("codex_project_catalog_unavailable");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

export async function readCodexProjectCatalog({
  userHome = homedir(),
  statePath = join(userHome, ".codex", ".codex-global-state.json"),
} = {}) {
  const document = await readCodexState(statePath);
  const values = document?.["local-projects"];
  const projects = [];
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const [fallbackId, project] of Object.entries(values).slice(0, 1_000)) {
      const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
      for (const [index, path] of roots.slice(0, 20).entries()) {
        if (typeof path !== "string" || !isAbsolute(path)) continue;
        projects.push({
          projectId: String(project?.id ?? `${fallbackId}-${index}`).slice(0, 200),
          projectKind: "local",
          label: String(project?.name ?? basename(path)).slice(0, 200),
          path,
          hostId: "local",
          hostDisplayName: null,
          isGitRepository: await lstat(join(path, ".git"))
            .then((item) => item.isDirectory()).catch(() => false),
        });
      }
    }
  }
  return { schemaVersion: 2, projects };
}
