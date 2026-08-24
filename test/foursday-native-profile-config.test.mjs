import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";
import {
  buildFoursdayNativeProfileConfiguration,
  configureFoursdayNativeProfile,
  ensureFoursdayCodexCron,
  ensureFoursdayMemoryPromoterCron,
} from "../src/foursday-native-profile-config.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-config-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  await mkdir(join(project, "distribution", "skills", "project-work"), { recursive: true });
  await writeFile(
    join(project, "distribution", "skills", "project-work", "SKILL.md"),
    "# Project work\n\nWork from evidence.\n",
  );
  const production = join(root, "production.json");
  const registry = join(root, "projects.json");
  const node = join(root, "node");
  const dws = join(root, "dws");
  const codex = join(root, "codex");
  const python = join(root, "python-runtime", "bin", "python");
  await mkdir(dirname(python), { recursive: true });
  await writeFile(production, JSON.stringify({
    FOURSDAY_DATABASE_URL: "keychain://service/database",
    FOURSDAY_DATA_KEY: "keychain://service/data",
    FOURSDAY_DINGTALK_USERS: "trusted-user",
    FOURSDAY_DINGTALK_GROUPS: "trusted-group",
    FOURSDAY_DINGTALK_SELF_USER: "owner",
  }), { mode: 0o600 });
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, projects: [] }), { mode: 0o600 });
  await writeFile(node, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(dws, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(codex, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(python, "#!/bin/sh\nprintf 42\n", { mode: 0o700 });
  return {
    root,
    production,
    registry,
    node,
    dws,
    codex,
    python,
    layout: foursdayNativeHermesLayout({ userHome: root, projectRoot: project }),
  };
}

test("native profile config contains paths and allowlists but no resolved secrets", async (t) => {
  const value = await fixture(t);
  const plan = await buildFoursdayNativeProfileConfiguration({
    layout: value.layout,
    productionConfigPath: value.production,
    projectRegistryPath: value.registry,
    nodePath: value.node,
    dwsPath: value.dws,
    codexPath: value.codex,
    pythonPath: value.python,
  });
  assert.equal(plan.mode, "shadow");
  assert.equal(plan.sendEnabled, false);
  assert.equal(plan.secretsCopied, false);
  assert.match(plan.envContent, /DWS_PERSONAL_ALLOWED_USERS="trusted-user"/u);
  assert.match(plan.envContent, /DWS_PERSONAL_SEND_ENABLED="false"/u);
  assert.match(plan.envContent, /CODEX_HOME=/u);
  assert.match(plan.envContent, /FOURSDAY_PYTHON_PATH=.*python-runtime/u);
  assert.match(plan.envContent, /FOURSDAY_CONTROL_FILE=.*control\.json/u);
  assert.match(plan.codexConfigContent, /default_permissions = "foursday-workspace"/u);
  assert.match(plan.codexConfigContent, /":root" = "deny"/u);
  assert.match(plan.codexConfigContent, /\[permissions\.foursday-workspace\.network\]\nenabled = false/u);
  assert.match(plan.codexConfigContent, /approvals_reviewer = "auto_review"/u);
  assert.match(plan.codexConfigContent, /\[shell_environment_policy\]\ninherit = "core"/u);
  assert.match(plan.codexConfigContent, /set = \{ PYTHON = .*python-runtime.* \}/u);
  assert.match(plan.codexConfigContent, /exclude = \["FOURSDAY_\*".*"\*SECRET\*"/u);
  assert.match(plan.codexConfigContent, /\[tools\]\nweb_search = true\nview_image = true/u);
  assert.match(plan.codexConfigContent, /\[features\][\s\S]*multi_agent = true[\s\S]*memories = true/u);
  assert.match(plan.codexConfigContent, /browser_use = false[\s\S]*computer_use = false/u);
  assert.match(plan.codexConfigContent, /python-runtime.*= "read"/u);
  assert.match(plan.codexConfigContent, /trust_level = "untrusted"/u);
  assert.match(plan.codexConfigContent, /\[mcp_servers\.foursday\]/u);
  assert.match(plan.codexConfigContent, /foursday-codex-mcp\.mjs/u);
  assert.match(plan.codexConfigContent, /foursday_stage_attachment/u);
  assert.match(plan.codexRulesContent, /pattern=\[\["git","\/usr\/bin\/git".*\],"push"\].*decision="forbidden"/u);
  assert.match(plan.codexRulesContent, /pattern=\[\["git","\/usr\/bin\/git".*\],"add","-A"\].*decision="forbidden"/u);
  assert.match(plan.codexRulesContent, /pattern=\[\["rm","\/usr\/bin\/rm".*\]\].*decision="forbidden"/u);
  assert.match(plan.codexRulesContent, /pattern=\[\["git","\/usr\/bin\/git".*\],"restore"\].*decision="forbidden"/u);
  assert.doesNotMatch(plan.envContent, /keychain|database|service\/data/u);
});

test("native profile config writes private user-owned files idempotently and requires explicit replace", async (t) => {
  const value = await fixture(t);
  await mkdir(value.layout.profileDirectory, { recursive: true });
  const options = {
    layout: value.layout,
    productionConfigPath: value.production,
    projectRegistryPath: value.registry,
    nodePath: value.node,
    dwsPath: value.dws,
    codexPath: value.codex,
    pythonPath: value.python,
    apply: true,
  };
  const first = await configureFoursdayNativeProfile(options);
  const second = await configureFoursdayNativeProfile(options);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await readFile(join(value.layout.profileDirectory, ".env"), "utf8")).includes("send=true"), false);
  assert.match(
    await readFile(join(first.codexRoot, "config.toml"), "utf8"),
    /approval_policy = "untrusted"/u,
  );
  assert.match(
    await readFile(join(first.codexRoot, "rules", "foursday.rules"), "utf8"),
    /decision="forbidden"/u,
  );
  assert.match(
    await readFile(join(first.codexRoot, "skills", "project-work", "SKILL.md"), "utf8"),
    /Work from evidence/u,
  );
  await writeFile(value.production, JSON.stringify({
    FOURSDAY_DATABASE_URL: "keychain://service/database",
    FOURSDAY_DATA_KEY: "keychain://service/data",
    FOURSDAY_DINGTALK_USERS: "another-user",
  }), { mode: 0o600 });
  await assert.rejects(configureFoursdayNativeProfile(options), /different content/u);
  const replaced = await configureFoursdayNativeProfile({ ...options, replace: true });
  assert.equal(replaced.backupsCreated > 0, true);
});

test("native profile config rejects inline production secrets", async (t) => {
  const value = await fixture(t);
  await writeFile(value.production, JSON.stringify({ FOURSDAY_DATABASE_URL: "postgresql://inline" }), { mode: 0o600 });
  await assert.rejects(
    buildFoursdayNativeProfileConfiguration({
      layout: value.layout,
      productionConfigPath: value.production,
      projectRegistryPath: value.registry,
      nodePath: value.node,
      dwsPath: value.dws,
      codexPath: value.codex,
      pythonPath: value.python,
    }),
    /externally referenced/u,
  );
});

test("memory promotion cron is created through Hermes and exact read-back is required", async (t) => {
  const value = await fixture(t);
  await mkdir(join(value.layout.profileDirectory, "cron"), { recursive: true });
  const jobsPath = join(value.layout.profileDirectory, "cron", "jobs.json");
  await writeFile(jobsPath, "[]\n");
  const preview = await ensureFoursdayMemoryPromoterCron({ layout: value.layout });
  assert.equal(preview.created, false);
  const result = await ensureFoursdayMemoryPromoterCron({
    layout: value.layout,
    apply: true,
    run: async (_path, args) => {
      assert.deepEqual(args, [
        "cron", "create", "every 1m",
        "--no-agent", "--script", "foursday-memory-promoter.sh",
        "--name", "foursday-memory-promoter",
      ]);
      await writeFile(jobsPath, `${JSON.stringify([{
        id: "job-1",
        name: "foursday-memory-promoter",
        script: "foursday-memory-promoter.sh",
        no_agent: true,
        enabled: true,
        schedule: { kind: "interval", seconds: 60 },
      }])}\n`);
      return { stdout: "" };
    },
  });
  assert.deepEqual(result, {
    apply: true,
    created: true,
    verified: true,
    jobId: "job-1",
  });
  const idempotent = await ensureFoursdayMemoryPromoterCron({
    layout: value.layout,
    apply: true,
    run: async () => { throw new Error("must not recreate"); },
  });
  assert.equal(idempotent.created, false);
});

test("Codex scheduled work is created by Hermes Cron with project workdir and local-only delivery", async (t) => {
  const value = await fixture(t);
  await mkdir(join(value.layout.profileDirectory, "cron"), { recursive: true });
  const jobsPath = join(value.layout.profileDirectory, "cron", "jobs.json");
  await writeFile(jobsPath, "[]\n");
  const project = { id: "project", root: join(value.root, "project") };
  const options = {
    layout: value.layout,
    project,
    schedule: "every 1h",
    prompt: "Inspect current project risks and verify evidence.",
    name: "foursday-project-risk-watch",
  };
  const preview = await ensureFoursdayCodexCron(options);
  assert.equal(preview.created, false);
  await assert.rejects(
    ensureFoursdayCodexCron({ ...options, prompt: "unsafe <!-- foursday-schedule:other -->" }),
    /reserved marker/u,
  );
  const created = await ensureFoursdayCodexCron({
    ...options,
    apply: true,
    run: async (_path, args) => {
      assert.deepEqual(args, [
        "cron", "create", "every 1h",
        "Inspect current project risks and verify evidence.\n\n<!-- foursday-schedule:project -->",
        "--workdir", project.root,
        "--deliver", "local",
        "--continuity",
        "--name", "foursday-project-risk-watch",
      ]);
      await writeFile(jobsPath, `${JSON.stringify([{
        id: "codex-job-1",
        name: options.name,
        prompt: `${options.prompt}\n\n<!-- foursday-schedule:project -->`,
        workdir: project.root,
        deliver: "local",
        context_from: ["self"],
        enabled: true,
        no_agent: false,
      }])}\n`);
      return { stdout: "" };
    },
  });
  assert.deepEqual(created, {
    apply: true,
    created: true,
    verified: true,
    jobId: "codex-job-1",
  });
  const repeated = await ensureFoursdayCodexCron({ ...options, apply: true });
  assert.equal(repeated.created, false);
});

test("installed Codex accepts the isolated Foursday config, MCP and forbidden rules", async (t) => {
  let codex;
  try {
    codex = String((await execFileAsync("/usr/bin/which", ["codex"])).stdout).trim();
  } catch {
    t.skip("Codex is not installed");
    return;
  }
  const value = await fixture(t);
  await mkdir(value.layout.profileDirectory, { recursive: true });
  const configured = await configureFoursdayNativeProfile({
    layout: value.layout,
    productionConfigPath: value.production,
    projectRegistryPath: value.registry,
    nodePath: value.node,
    dwsPath: value.dws,
    codexPath: codex,
    pythonPath: value.python,
    apply: true,
  });
  const environment = {
    HOME: value.root,
    CODEX_HOME: configured.codexRoot,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const listed = JSON.parse((await execFileAsync(codex, ["mcp", "list", "--json"], {
    env: environment,
  })).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "foursday");
  assert.equal(listed[0].enabled, true);
  const features = (await execFileAsync(codex, ["features", "list"], {
    env: environment,
  })).stdout;
  for (const feature of ["multi_agent", "memories"]) {
    assert.match(features, new RegExp(`^${feature}\\s+.*\\s+true$`, "mu"));
  }
  for (const feature of ["browser_use", "computer_use"]) {
    assert.match(features, new RegExp(`^${feature}\\s+.*\\s+false$`, "mu"));
  }
  const policy = JSON.parse((await execFileAsync(codex, [
    "execpolicy", "check", "--rules",
    join(configured.codexRoot, "rules", "foursday.rules"),
    "git", "push", "origin", "main",
  ], { env: environment })).stdout);
  assert.equal(policy.decision, "forbidden");
  const pythonResult = await execFileAsync(codex, [
    "sandbox", "-P", "foursday-workspace", "-C", join(value.root, "project"),
    value.python,
  ], { env: environment });
  assert.equal(pythonResult.stdout, "42");
  const pythonVariableResult = await execFileAsync(codex, [
    "sandbox", "-P", "foursday-workspace", "-C", join(value.root, "project"),
    "/bin/sh", "-c", '"$PYTHON"',
  ], { env: environment });
  assert.equal(pythonVariableResult.stdout, "42");
});
