import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncFoursdayCodexProjects } from "../src/foursday-codex-project-sync.mjs";

test("Codex project sync adds saved projects, preserves authority and is preview-first", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "foursday-project-sync-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  const privateRoot = join(home, "private");
  const oldRoot = join(home, "Projects", "Existing");
  const newRoot = join(home, "Projects", "招陪考2.0");
  await Promise.all([privateRoot, oldRoot, newRoot].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const registryPath = join(privateRoot, "projects.json");
  const codexStatePath = join(privateRoot, "codex-state.json");
  const original = {
    schemaVersion: 2,
    workspaces: [{ id: "existing", root: oldRoot, gitRemote: null, runInstructions: "Keep me." }],
    scopes: [{ id: "existing", name: "Existing", aliases: ["old"], parentId: null, workspaceId: "existing", gbrainSlugs: ["projects/existing"], dingtalkSources: [] }],
  };
  await writeFile(registryPath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  await writeFile(codexStatePath, `${JSON.stringify({
    "local-projects": {
      training: { id: "training", name: "招陪考2.2", rootPaths: [newRoot] },
    },
  })}\n`, { mode: 0o600 });
  const options = {
    registryPath, codexStatePath, userHome: home,
    gbrainProjects: [{ slug: "projects/training", title: "51Talk AI 招培考 2.2 正课训练 Demo" }],
    run: async () => ({ stdout: "" }),
  };
  const preview = await syncFoursdayCodexProjects(options);
  assert.equal(preview.changed, true);
  assert.equal(preview.addedProjectCount, 1);
  assert.equal(preview.fixedMemoryPageCount, 2);
  assert.equal((await readFile(registryPath, "utf8")).trim(), JSON.stringify(original));
  const applied = await syncFoursdayCodexProjects({ ...options, apply: true });
  assert.equal(applied.readbackVerified, true);
  assert.equal((await stat(registryPath)).mode & 0o077, 0);
  const value = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(value.scopes.some((scope) => scope.name === "Existing" && scope.aliases.includes("old")), true);
  const training = value.scopes.find((scope) => scope.name === "招陪考2.2");
  assert.equal(training.aliases.includes("51Talk AI 招培考 2.2 正课训练 Demo"), false);
  assert.deepEqual(training.gbrainSlugs, ["projects/training"]);
  assert.deepEqual(JSON.parse(await readFile(`${registryPath}.before-codex-sync`, "utf8")), original);
  const repeated = await syncFoursdayCodexProjects({ ...options, apply: true });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.productionWrite, false);

  let activeRuns = 0;
  let maximumRuns = 0;
  const serialized = {
    ...options,
    apply: true,
    run: async () => {
      activeRuns += 1;
      maximumRuns = Math.max(maximumRuns, activeRuns);
      await new Promise((accept) => setTimeout(accept, 15));
      activeRuns -= 1;
      return { stdout: "" };
    },
  };
  await Promise.all([
    syncFoursdayCodexProjects(serialized),
    syncFoursdayCodexProjects(serialized),
  ]);
  assert.equal(maximumRuns, 1);
});

test("Codex project sync rejects an unsafe catalog without changing the active registry", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "foursday-project-sync-unsafe-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  const registryPath = join(home, "projects.json");
  const codexStatePath = join(home, "codex-state.json");
  const registry = { schemaVersion: 2, workspaces: [], scopes: [] };
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  await writeFile(codexStatePath, `${JSON.stringify({ "local-projects": {} })}\n`, { mode: 0o666 });
  await chmod(codexStatePath, 0o666);
  await assert.rejects(syncFoursdayCodexProjects({
    registryPath, codexStatePath, userHome: home, apply: true,
  }), /codex_project_catalog_unavailable/u);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), registry);
});
