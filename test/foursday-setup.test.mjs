import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveFoursdaySetupSelections,
  runFoursdaySetup,
} from "../src/foursday-setup.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-setup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const project = join(root, "Projects", "Foursday");
  await mkdir(project, { recursive: true, mode: 0o700 });
  const configPath = join(root, "production.json");
  await writeFile(configPath, "{}\n", { mode: 0o600 });
  const detected = {
    nodeReady: true,
    gitPath: "/usr/bin/git",
    codexPath: "/usr/bin/codex",
    dwsPath: "/usr/bin/dws",
    codexAuthenticated: true,
    dwsProfiles: [{ profile: "private-profile", label: "工作账号", current: true, status: "ready" }],
    currentDwsProfile: "private-profile",
    codexCatalog: {
      schemaVersion: 2,
      projects: [{
        projectId: "foursday", projectKind: "local", label: "Foursday", path: project,
        hostId: "local", hostDisplayName: null, isGitRepository: false,
      }],
    },
  };
  return { root, project, configPath, detected, setupRoot: join(root, ".foursday") };
}

test("setup preview composes one trial flow without writing", async (t) => {
  const value = await fixture(t);
  let operationCount = 0;
  const result = await runFoursdaySetup({
    configPath: value.configPath,
    userHome: value.root,
    setupRoot: value.setupRoot,
    inspect: async () => value.detected,
    install: async () => { operationCount += 1; },
  });
  assert.equal(result.state, "preview");
  assert.equal(result.ready, false);
  assert.equal(result.selectedProjectCount, 1);
  assert.equal(result.recommendedAction, "运行 foursday setup --apply");
  assert.equal(operationCount, 0);
  await assert.rejects(readFile(join(value.setupRoot, "setup-state.json")), /ENOENT/u);
  assert.doesNotMatch(JSON.stringify(result), /private-profile|production\.json|Projects/u);
  assert.doesNotMatch(JSON.stringify(result.steps), /runtime|profile|shadow|verification|gbrainState/iu);
});

test("setup apply runs the resumable trial pipeline and never activates sending", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const options = {
    apply: true,
    configPath: value.configPath,
    userHome: value.root,
    setupRoot: value.setupRoot,
    inspect: async () => value.detected,
    listMemoryProjects: async () => [{ slug: "projects/foursday", title: "Foursday" }],
    install: async ({ apply }) => { calls.push(["install", apply]); return { installed: true }; },
    configure: async ({ apply }) => { calls.push(["configure", apply]); return { profileConfigured: true }; },
    login: async ({ apply }) => { calls.push(["login", apply]); return { authenticated: true }; },
    gateway: async (action, { apply }) => { calls.push([action, apply]); return { ready: true }; },
    verify: async ({ apply }) => { calls.push(["verify", apply]); return { verified: true }; },
  };
  const first = await runFoursdaySetup(options);
  assert.equal(first.state, "trial_ready");
  assert.equal(first.ready, true);
  assert.equal(first.messagesSent, 0);
  assert.equal(first.productionWrite, false);
  assert.deepEqual(calls, [
    ["install", true], ["configure", true], ["login", true],
    ["install-shadow", true], ["start-shadow", true], ["verify", true],
  ]);
  const state = JSON.parse(await readFile(join(value.setupRoot, "setup-state.json"), "utf8"));
  assert.deepEqual(state.completed, [
    "prerequisites", "account", "projects", "runtime", "profile", "codex", "shadow", "verification",
  ]);
  assert.doesNotMatch(JSON.stringify(state), /private-profile|production\.json|Projects/u);
  calls.length = 0;
  const resumed = await runFoursdaySetup(options);
  assert.equal(resumed.state, "trial_ready");
  assert.deepEqual(calls, []);

  const secondProject = join(value.root, "Projects", "Second");
  await mkdir(secondProject, { recursive: true, mode: 0o700 });
  const changed = await runFoursdaySetup({ ...options, roots: [secondProject] });
  assert.equal(changed.state, "trial_ready");
  assert.deepEqual(calls, [
    ["install", true], ["configure", true], ["login", true],
    ["install-shadow", true], ["start-shadow", true], ["verify", true],
  ]);
  calls.length = 0;
  await runFoursdaySetup({ ...options, roots: [secondProject], releaseIdentity: "next-release" });
  assert.equal(calls.length, 6);
});

test("setup asks only for information it cannot infer", async (t) => {
  const value = await fixture(t);
  const result = await runFoursdaySetup({
    configPath: value.configPath,
    userHome: value.root,
    setupRoot: value.setupRoot,
    inspect: async () => ({
      ...value.detected,
      currentDwsProfile: null,
      dwsProfiles: [
        { profile: "one", label: "账号一", current: false },
        { profile: "two", label: "账号二", current: false },
      ],
      codexCatalog: {
        schemaVersion: 2,
        projects: [
          ...value.detected.codexCatalog.projects,
          { ...value.detected.codexCatalog.projects[0], projectId: "two", label: "第二项目", path: join(value.root, "Projects", "Second") },
        ],
      },
    }),
  });
  assert.equal(result.state, "needs_input");
  assert.equal(result.questionsAsked, 2);
  assert.deepEqual(result.questions.map((item) => item.id), ["dingtalk_account", "project_roots"]);
  assert.equal(result.questions.length <= 3, true);
});

test("setup reports one action when prerequisites or private configuration are missing", async (t) => {
  const value = await fixture(t);
  const missingTool = await runFoursdaySetup({
    configPath: value.configPath,
    userHome: value.root,
    setupRoot: value.setupRoot,
    inspect: async () => ({ ...value.detected, dwsPath: null }),
  });
  assert.equal(missingTool.state, "needs_action");
  assert.equal(missingTool.recommendedAction, "在 Codex 中安装缺少的工具后重试");
  const missingConfig = await runFoursdaySetup({
    configPath: join(value.root, "missing.json"),
    userHome: value.root,
    setupRoot: value.setupRoot,
    inspect: async () => value.detected,
  });
  assert.equal(missingConfig.state, "needs_action");
  assert.equal(missingConfig.recommendedAction, "在 Codex／Claude 插件中连接 PostgreSQL 与个人 gbrain");
});

test("interactive selection asks at most for account and project roots without exposing identifiers", async (t) => {
  const value = await fixture(t);
  const second = join(value.root, "Projects", "Second");
  await mkdir(second, { recursive: true, mode: 0o700 });
  const prompts = [];
  const selected = await resolveFoursdaySetupSelections({
    ...value.detected,
    currentDwsProfile: null,
    dwsProfiles: [
      { profile: "secret-account-one", label: "工作账号一" },
      { profile: "secret-account-two", label: "工作账号二" },
    ],
    codexCatalog: {
      schemaVersion: 2,
      projects: [
        ...value.detected.codexCatalog.projects,
        { ...value.detected.codexCatalog.projects[0], path: second, label: "第二项目" },
      ],
    },
  }, {
    askOne: async (question) => { prompts.push(question); return 1; },
    askMany: async (question) => { prompts.push(question); return [0, 1]; },
  });
  assert.equal(selected.questionsAsked, 2);
  assert.equal(selected.account, "secret-account-two");
  assert.deepEqual(selected.roots, [value.project, second]);
  assert.doesNotMatch(JSON.stringify(prompts), /secret-account/u);
});
