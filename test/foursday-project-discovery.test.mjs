import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverFoursdayProjectRegistry } from "../src/foursday-project-discovery.mjs";
import { runFoursdayProjectDiscovery } from "../scripts/发现Foursday项目.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-project-discovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "单词");
  const child = join(parent, "单词2.2");
  const dsh = join(root, "DSH");
  const legacy = join(root, "legacy");
  const sensitive = join(root, ".ssh", "project");
  await Promise.all([parent, child, dsh, legacy, sensitive].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  return { root, parent, child, dsh, legacy, sensitive };
}

test("project discovery preserves v1 authority and infers nearest project parents", async (t) => {
  const paths = await fixture(t);
  const catalog = {
    schemaVersion: 2,
    projects: [
      { projectId: "home", projectKind: "local", label: "Home", path: paths.root, hostId: "local", hostDisplayName: null, isGitRepository: false },
      { projectId: "parent", projectKind: "local", label: "单词", path: paths.parent, hostId: "local", hostDisplayName: null, isGitRepository: false },
      { projectId: "child", projectKind: "local", label: "单词2.2", path: paths.child, hostId: "local", hostDisplayName: null, isGitRepository: false },
      { projectId: "dsh", projectKind: "local", label: "DSH", path: paths.dsh, hostId: "local", hostDisplayName: null, isGitRepository: true },
      { projectId: "secret", projectKind: "local", label: "Sensitive", path: paths.sensitive, hostId: "local", hostDisplayName: null, isGitRepository: false },
    ],
  };
  const existingRegistry = {
    schemaVersion: 1,
    projects: [{
      id: "vocab_2_2", name: "单词 2.2", aliases: ["2.2"], root: paths.child,
      gbrainSlugs: ["projects/51t-word-2-2"],
    }, {
      id: "legacy", name: "Legacy", aliases: [], root: paths.legacy,
      gbrainSlugs: ["projects/legacy"],
    }],
  };
  const options = {
    catalog,
    existingRegistry,
    gbrainProjects: [{ slug: "projects/dsh", title: "DSH" }],
    userHome: paths.root,
    run: async () => ({ stdout: "git@github.com:example/project.git\n" }),
  };
  const first = await discoverFoursdayProjectRegistry(options);
  const second = await discoverFoursdayProjectRegistry(options);
  assert.deepEqual(first, second);
  assert.equal(first.registry.schemaVersion, 2);
  assert.equal(first.summary.sourceProjects, 5);
  assert.equal(first.summary.excludedProjects, 2);
  assert.deepEqual(new Set(first.summary.excluded.map((item) => item.reason)), new Set(["too_broad_or_outside_home"]));
  assert.equal(first.summary.includedProjects, 3);
  assert.equal(first.summary.retainedProjects, 1);
  const parent = first.registry.scopes.find((scope) => scope.name === "单词");
  const child = first.registry.scopes.find((scope) => scope.id === "vocab_2_2");
  const dsh = first.registry.scopes.find((scope) => scope.name === "DSH");
  assert.equal(child.parentId, parent.id);
  assert.deepEqual(child.gbrainSlugs, ["projects/51t-word-2-2"]);
  assert.deepEqual(dsh.gbrainSlugs, ["projects/dsh"]);
  assert.equal(first.registry.scopes.some((scope) => scope.id === "legacy"), true);
  assert.equal(first.registry.workspaces.some((workspace) => workspace.id === "legacy"), true);
  assert.equal(first.registry.workspaces.find((workspace) => workspace.id === "dsh").gitRemote, "https://github.com/example/project.git");

  const ambiguous = await discoverFoursdayProjectRegistry({
    ...options,
    gbrainProjects: [
      { slug: "projects/dsh-one", title: "DSH" },
      { slug: "projects/dsh-two", title: "DSH" },
    ],
  });
  assert.deepEqual(ambiguous.registry.scopes.find((scope) => scope.name === "DSH").gbrainSlugs, []);
});

test("project discovery CLI is preview-first and writes only a separate private candidate", async (t) => {
  const paths = await fixture(t);
  const privateRoot = join(paths.root, "private");
  const profileDirectory = join(paths.root, "profile");
  await mkdir(privateRoot, { mode: 0o700 });
  const catalogPath = join(privateRoot, "codex-projects.json");
  const existingPath = join(privateRoot, "projects.json");
  const outputPath = join(privateRoot, "projects.v2.json");
  await writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: 2,
    projects: [{ projectId: "dsh", projectKind: "local", label: "DSH", path: paths.dsh, hostId: "local", hostDisplayName: null, isGitRepository: true }],
  })}\n`, { mode: 0o600 });
  await writeFile(existingPath, `${JSON.stringify({ schemaVersion: 2, workspaces: [], scopes: [] })}\n`, { mode: 0o600 });
  const dependencies = {
    environment: { FOURSDAY_CONFIG_FILE: join(privateRoot, "unused.json") },
    layout: { profileDirectory, userHome: paths.root },
    createMemoryClient: async () => ({
      listProjects: async () => ({
        sourceId: "default",
        projects: [{ slug: "projects/dsh", title: "DSH" }],
        truncated: false,
      }),
    }),
  };
  const common = ["--catalog", catalogPath, "--existing", existingPath, "--output", outputPath];
  const preview = await runFoursdayProjectDiscovery(common, dependencies);
  assert.equal(preview.apply, false);
  assert.equal(preview.candidateWritten, false);
  await assert.rejects(readFile(outputPath), /ENOENT/u);
  const applied = await runFoursdayProjectDiscovery([...common, "--apply"], dependencies);
  assert.equal(applied.apply, true);
  assert.equal(applied.productionWrite, false);
  assert.equal(applied.activeRegistryChanged, false);
  assert.equal(applied.discoverableGbrainProjects, 1);
  assert.equal((await stat(outputPath)).mode & 0o077, 0);
  const candidate = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(candidate.schemaVersion, 2);
  assert.equal(candidate.scopes[0].name, "DSH");
  await assert.rejects(
    runFoursdayProjectDiscovery([
      "--catalog", catalogPath, "--existing", existingPath,
      "--output", existingPath, "--apply",
    ], dependencies),
    /cannot overwrite the active registry/u,
  );
  const aliasRoot = join(paths.root, "alias-private");
  await symlink(privateRoot, aliasRoot);
  await assert.rejects(
    runFoursdayProjectDiscovery([
      "--catalog", catalogPath, "--existing", existingPath,
      "--output", join(aliasRoot, "projects.json"), "--apply",
    ], dependencies),
    /cannot overwrite the active registry/u,
  );
});

test("project discovery conservatively joins a unique one-character gbrain name variant", async (t) => {
  const paths = await fixture(t);
  const result = await discoverFoursdayProjectRegistry({
    catalog: {
      schemaVersion: 2,
      projects: [{
        projectId: "training", projectKind: "local", label: "招陪考2.2",
        path: paths.dsh, hostId: "local", hostDisplayName: null, isGitRepository: false,
      }],
    },
    gbrainProjects: [{ slug: "projects/coach-training-2-2", title: "51Talk AI 招培考 2.2 正课训练 Demo" }],
    userHome: paths.root,
  });
  const scope = result.registry.scopes[0];
  assert.deepEqual(scope.gbrainSlugs, ["projects/coach-training-2-2"]);
  assert.equal(scope.aliases.includes("51Talk AI 招培考 2.2 正课训练 Demo"), false);

  const ambiguous = await discoverFoursdayProjectRegistry({
    catalog: {
      schemaVersion: 2,
      projects: [{
        projectId: "training", projectKind: "local", label: "招陪考2.2",
        path: paths.dsh, hostId: "local", hostDisplayName: null, isGitRepository: false,
      }],
    },
    gbrainProjects: [
      { slug: "projects/a", title: "招培考 2.2" },
      { slug: "projects/b", title: "招陪考 2.2" },
    ],
    userHome: paths.root,
  });
  assert.deepEqual(ambiguous.registry.scopes[0].gbrainSlugs, ["projects/b"]);
});
