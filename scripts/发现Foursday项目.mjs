#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHermesPersonalMemoryClient } from "../src/hermes-personal-memory-context.mjs";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";
import { discoverFoursdayProjectRegistry } from "../src/foursday-project-discovery.mjs";
import { defaultProductionConfigPath } from "../src/production-config-file.mjs";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

async function privateJson(path, { optional = false } = {}) {
  if (!path || !isAbsolute(path)) {
    if (optional && !path) return null;
    throw new Error("Foursday discovery input must be an absolute path");
  }
  const absolute = resolve(path);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 2 * 1024 * 1024 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("Foursday discovery input file is unsafe");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function canonicalDestination(path) {
  if (!path || !isAbsolute(path)) throw new Error("Foursday discovery path must be absolute");
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

async function writePrivateJson(path, value, { forbiddenPath = null } = {}) {
  if (!path || !isAbsolute(path)) throw new Error("Foursday discovery output must be absolute");
  const absolute = resolve(path);
  const parent = dirname(absolute);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const destination = await canonicalDestination(absolute);
  if (forbiddenPath && destination === await canonicalDestination(forbiddenPath)) {
    throw new Error("Foursday discovery cannot overwrite the active registry");
  }
  const existing = await lstat(destination).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (
    existing?.isSymbolicLink() || (existing && !existing.isFile()) ||
    (existing && (existing.mode & 0o077) !== 0) ||
    (existing && typeof process.getuid === "function" && existing.uid !== process.getuid())
  ) {
    throw new Error("Foursday discovery output is unsafe");
  }
  const temporary = join(dirname(destination), `.foursday-projects-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function runFoursdayProjectDiscovery(args = process.argv.slice(2), {
  environment = process.env,
  layout = foursdayNativeHermesLayout({ projectRoot }),
  createMemoryClient = createHermesPersonalMemoryClient,
} = {}) {
  const catalogPath = argument(args, "--catalog");
  const existingPath = argument(args, "--existing") ?? join(
    layout.profileDirectory,
    "local", "foursday", "projects.json",
  );
  const outputPath = argument(args, "--output");
  const apply = args.includes("--apply");
  const valueFlags = new Set(["--catalog", "--existing", "--output"]);
  if (
    args.some((value, index) =>
      value !== "--apply" && !valueFlags.has(value) && !valueFlags.has(args[index - 1])) ||
    !catalogPath || (apply && !outputPath)
  ) {
    throw new Error("Usage: foursday projects discover --catalog /private/codex-projects.json [--existing /private/projects.json] [--output /private/projects.v2.json --apply]");
  }
  if (outputPath && resolve(outputPath) === resolve(existingPath)) {
    throw new Error("Foursday discovery cannot overwrite the active registry");
  }
  const [catalog, existingRegistry] = await Promise.all([
    privateJson(catalogPath),
    privateJson(existingPath, { optional: true }),
  ]);
  let gbrainProjects = [];
  let gbrainState = "unavailable";
  try {
    const client = await createMemoryClient({
      configPath: environment.FOURSDAY_CONFIG_FILE ?? defaultProductionConfigPath(),
    });
    const result = await client.listProjects({ maximum: 1_000 });
    gbrainProjects = result.projects;
    gbrainState = result.truncated ? "truncated" : "ready";
  } catch {
    // Local projects remain discoverable when the optional memory catalog is unavailable.
  }
  const discovered = await discoverFoursdayProjectRegistry({
    catalog,
    existingRegistry: existingRegistry ?? { schemaVersion: 2, workspaces: [], scopes: [] },
    gbrainProjects,
    userHome: layout.userHome,
  });
  if (apply) await writePrivateJson(outputPath, discovered.registry, { forbiddenPath: existingPath });
  return {
    schema: "foursday-project-discovery/v1",
    apply,
    productionWrite: false,
    activeRegistryChanged: false,
    candidateWritten: apply,
    gbrainState,
    discoverableGbrainProjects: gbrainProjects.length,
    ...discovered.summary,
  };
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await runFoursdayProjectDiscovery(), null, 2));
}
