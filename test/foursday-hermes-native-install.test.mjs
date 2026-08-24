import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildFoursdayNativeInstallPlan,
  assertFoursdayEmbeddedRuntimeIdentity,
  downloadVerifiedInstaller,
  finishFoursdayNativeProfileInstall,
  foursdayNativeHermesLayout,
  inspectFoursdaySourceCommit,
  pruneFoursdayOptionalNodeDependencies,
  runFoursdayNativeHermesInstall,
  prepareNativeHermesInstallDirectory,
  recoverInterruptedNativeHermesInstall,
  stageFoursdayProfileDistribution,
  verifyFoursdaySingleAgentLoopContract,
} from "../src/foursday-hermes-native-install.mjs";

async function writeSingleLoopRuntime(layout, { bypass = true } = {}) {
  await mkdir(join(layout.installDirectory, "agent"), { recursive: true, mode: 0o700 });
  await writeFile(join(layout.installDirectory, "agent", "conversation_loop.py"), bypass
    ? 'if agent.api_mode == "codex_app_server":\n    return agent._run_codex_app_server_turn(\n'
    : "while agent.iterates():\n    pass\n");
  await writeFile(join(layout.installDirectory, "agent", "codex_runtime.py"),
    '"""Hands the entire turn to a `codex app-server` subprocess."""\nCodexAppServerSession = object\n' +
    'is_approval_bypass_active()\nauto_approve_exec=auto_approve_requests\n');
  await writeFile(join(layout.installDirectory, "agent", "agent_init.py"),
    'mem_config.get("nudge_interval", 10)\nskills_config.get("creation_nudge_interval", 10)\n');
  await writeFile(join(layout.installDirectory, "agent", "background_review.py"),
    'task.get("enabled"), default=True\n');
  await writeFile(join(layout.installDirectory, "agent", "title_generator.py"),
    'title_config.get("enabled"), default=True\n');
  await writeFile(join(layout.installDirectory, "agent", "curator.py"),
    'cfg.get("enabled", True)\n');
}

async function writeSingleLoopProfile(layout) {
  await mkdir(layout.profileDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(layout.profileDirectory, "config.yaml"), [
    "openai_runtime: codex_app_server",
    "approvals:",
    "  mode: 'off'",
    "display:",
    "  show_commentary: false",
    "  tool_progress: off",
    "  interim_assistant_messages: false",
    "  long_running_notifications: false",
    "  busy_ack_enabled: false",
    "streaming:",
    "  enabled: false",
    "background_review:",
    "    enabled: false",
    "title_generation:",
    "    enabled: false",
    "memory_enabled: false",
    "user_profile_enabled: false",
    "nudge_interval: 0",
    "creation_nudge_interval: 0",
    "curator:",
    "  enabled: false",
    "",
  ].join("\n"), { mode: 0o600 });
}

function lock(body) {
  return {
    repository: "https://github.com/NousResearch/hermes-agent.git",
    release: "v2026.8.18",
    version: "0.20.4",
    commit: "e".repeat(40),
    installerPath: "scripts/install.sh",
    installerSha256: createHash("sha256").update(body).digest("hex"),
  };
}

test("native Hermes plan uses only official Profile and Gateway surfaces", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-plan-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const plan = buildFoursdayNativeInstallPlan({ lock: lock("x".repeat(10_000)), layout, installGateway: true });
  assert.equal(plan.layout.hermesHome, join(root, ".hermes"));
  assert.equal(plan.layout.profile, "foursday");
  assert.equal(plan.profile.gatewayInstallRequested, true);
  assert.equal(plan.messagesSent, 0);
  assert.equal(plan.productionWrite, false);
});

test("official installer falls back to authenticated GitHub contents with the same digest", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-installer-api-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("#!/bin/sh\n" + "#".repeat(10_000));
  const upstream = lock(body);
  const calls = [];
  const installer = await downloadVerifiedInstaller(upstream, {
    environment: { GITHUB_TOKEN: "test-token" },
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (String(url).startsWith("https://raw.githubusercontent.com/")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({
        type: "file",
        encoding: "base64",
        content: body.toString("base64"),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  t.after(() => rm(installer.directory, { recursive: true, force: true }));
  assert.deepEqual(await readFile(installer.path), body);
  assert.equal(installer.digest, upstream.installerSha256);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].headers.Authorization, "Bearer test-token");
  assert.match(calls[1][0], /^https:\/\/api\.github\.com\/repos\/NousResearch\/hermes-agent\/contents\//u);
});

test("official installer accepts only a digest-matched local fallback when GitHub is unavailable", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-installer-local-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("#!/bin/sh\n" + "#".repeat(10_000));
  const fallback = join(root, "install.sh");
  await writeFile(fallback, body, { mode: 0o600 });
  const installer = await downloadVerifiedInstaller(lock(body), {
    fallbackPath: fallback,
    environment: {},
    fetchImpl: async () => new Response("unavailable", { status: 429 }),
  });
  t.after(() => rm(installer.directory, { recursive: true, force: true }));
  assert.deepEqual(await readFile(installer.path), body);
  assert.equal(installer.digest, createHash("sha256").update(body).digest("hex"));
});

test("source commit identity requires a clean worktree without hidden index flags", async () => {
  const head = "f".repeat(40);
  const run = async (_path, args) => {
    if (args.includes("rev-parse")) return { stdout: `${head}\n` };
    if (args.includes("status")) return { stdout: "" };
    if (args.includes("ls-files")) return { stdout: "H README.md\n" };
    throw new Error("unexpected command");
  };
  assert.equal(await inspectFoursdaySourceCommit("/private/project", {
    userHome: "/private/home",
    run,
  }), head);
  assert.equal(await inspectFoursdaySourceCommit("/private/project", {
    userHome: "/private/home",
    run: async (path, args, options) => {
      const result = await run(path, args, options);
      return args.includes("status") ? { stdout: " M README.md\n" } : result;
    },
  }), null);
  assert.equal(await inspectFoursdaySourceCommit("/private/project", {
    userHome: "/private/home",
    run: async (path, args, options) => {
      const result = await run(path, args, options);
      return args.includes("ls-files") ? { stdout: "h README.md\n" } : result;
    },
  }), null);
});

test("embedded runtime identity permits only the official installer contributor stamp", async () => {
  const expectedCommit = "e".repeat(40);
  const expectedRepository = "https://github.com/NousResearch/hermes-agent.git";
  const makeRun = (status, indexFlags = "H agent/conversation_loop.py\n") =>
    async (_path, args) => {
      if (args.includes("rev-parse")) return { stdout: `${expectedCommit}\n` };
      if (args.includes("get-url")) return { stdout: `${expectedRepository}\n` };
      if (args.includes("status")) return { stdout: status };
      if (args.includes("ls-files")) return { stdout: indexFlags };
      throw new Error("unexpected git command");
    };
  const layout = {
    userHome: "/private/home",
    installDirectory: "/private/runtime",
    hermesCommand: "/private/bin/runtime",
  };
  const valid = await assertFoursdayEmbeddedRuntimeIdentity(layout, {
    expectedCommit,
    expectedRepository,
    run: makeRun(" M contributors/emails/agent@fixture.local\n"),
  });
  assert.equal(valid.installerNoiseFiles, 1);
  await assert.rejects(assertFoursdayEmbeddedRuntimeIdentity(layout, {
    expectedCommit,
    expectedRepository,
    run: makeRun(" M agent/conversation_loop.py\n"),
  }), /immutable Foursday lock/u);
  await assert.rejects(assertFoursdayEmbeddedRuntimeIdentity(layout, {
    expectedCommit,
    expectedRepository,
    run: makeRun("", "h agent/conversation_loop.py\n"),
  }), /immutable Foursday lock/u);
});

test("locked runtime must bypass its own tool loop and expose switches for all background agent loops", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-single-loop-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await writeSingleLoopRuntime(layout);
  assert.equal((await verifyFoursdaySingleAgentLoopContract(layout)).valid, true);
  await writeFile(join(layout.installDirectory, "agent", "conversation_loop.py"), "while true:\n    pass\n");
  await assert.rejects(verifyFoursdaySingleAgentLoopContract(layout), /single Codex loop contract/u);
});

test("fresh install creates a private canonical runtime parent before cloning", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-parent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const result = await prepareNativeHermesInstallDirectory(layout, lock("x".repeat(10_000)));
  assert.deepEqual(result, { backup: null, existingGitCheckout: false });
  const parent = join(root, ".hermes");
  assert.equal(await realpath(parent), parent);
  const { mode } = await stat(parent);
  assert.equal(mode & 0o077, 0);
});

test("optional Node dependencies are pruned only after verification and restored on failure", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-runtime-prune-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  for (const relative of ["node_modules", "apps/desktop/node_modules"]) {
    await mkdir(join(layout.installDirectory, relative), { recursive: true, mode: 0o700 });
    await writeFile(join(layout.installDirectory, relative, "fixture"), "x");
  }
  const preview = await pruneFoursdayOptionalNodeDependencies(layout);
  assert.deepEqual(preview.targets, ["node_modules", "apps/desktop/node_modules"]);
  await access(join(layout.installDirectory, "node_modules", "fixture"));
  let verified = false;
  const applied = await pruneFoursdayOptionalNodeDependencies(layout, {
    apply: true,
    verify: async () => {
      verified = true;
      await assert.rejects(access(join(layout.installDirectory, "node_modules")));
    },
  });
  assert.equal(verified, true);
  assert.equal(applied.pruned, true);
  await assert.rejects(access(join(layout.installDirectory, "node_modules")));

  await mkdir(join(layout.installDirectory, "node_modules"), { mode: 0o700 });
  await writeFile(join(layout.installDirectory, "node_modules", "restored"), "x");
  await assert.rejects(pruneFoursdayOptionalNodeDependencies(layout, {
    apply: true,
    verify: async () => { throw new Error("verification failed"); },
  }), /verification failed/u);
  await access(join(layout.installDirectory, "node_modules", "restored"));
});

test("profile staging packages plugins, profile and skills without Python caches", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-stage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "distribution", "profile"), { recursive: true });
  await mkdir(join(root, "distribution", "skills", "project-work"), { recursive: true });
  await writeFile(join(root, "distribution", "profile", "SOUL.md"), "# Foursday\n");
  await writeFile(join(root, "distribution", "skills", "project-work", "SKILL.md"), "# Skill\n");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "scripts"));
  for (const name of [
    "hermes-dws-sidecar.mjs",
    "hermes-personal-memory-context.mjs",
    "hermes-memory-candidate-sidecar.mjs",
    "foursday-codex-mcp.mjs",
    "foursday-codex-proxy.mjs",
    "personal-gbrain-promoter.mjs",
  ]) await writeFile(join(root, "src", name), "// host\n");
  await writeFile(join(root, "scripts", "运行个人gbrain记忆晋升.mjs"), "// promoter\n");
  await mkdir(join(root, "distribution", "host"));
  await writeFile(join(root, "distribution", "host", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(join(root, "distribution", "host", "package-lock.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0" } },
  }));
  for (const name of [
    "dws_personal", "project_router",
    "foursday_work_twin",
  ]) {
    await mkdir(join(root, "distribution", "plugins", name), { recursive: true });
    await writeFile(join(root, "distribution", "plugins", name, "plugin.yaml"), `name: ${name}\n`);
    await writeFile(join(root, "distribution", "plugins", name, "__init__.py"), "# plugin\n");
  }
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const result = await stageFoursdayProfileDistribution({
    layout,
    version: "0.6.0",
    hermesVersion: "0.20.4",
  });
  assert.equal(result.pluginCount, 1);
  assert.equal(result.componentPluginCount, 2);
  const distribution = await readFile(join(result.stage, "distribution.yaml"), "utf8");
  assert.match(distribution, /hermes_requires: '==0\.20\.4'/u);
  assert.match(distribution, /foursday-release\.json/u);
  assert.equal(JSON.parse(
    await readFile(join(result.stage, "foursday-release.json"), "utf8"),
  ).foursdayCommit, null);
  const profileConfiguration = await readFile(join(result.stage, "config.yaml"), "utf8");
  assert.match(profileConfiguration, /foursday-work-twin/u);
  assert.match(profileConfiguration, /approvals:\n  mode: 'off'/u);
  assert.match(profileConfiguration, /display:\n  show_commentary: false\n  tool_progress: off\n  interim_assistant_messages: false\n  long_running_notifications: false\n  busy_ack_enabled: false/u);
  assert.match(profileConfiguration, /streaming:\n  enabled: false/u);
  assert.match(profileConfiguration, /background_review:\n    enabled: false/u);
  assert.match(profileConfiguration, /title_generation:\n    enabled: false/u);
  assert.match(profileConfiguration, /memory_enabled: false/u);
  assert.match(profileConfiguration, /user_profile_enabled: false/u);
  assert.match(profileConfiguration, /nudge_interval: 0/u);
  assert.match(profileConfiguration, /creation_nudge_interval: 0/u);
  assert.match(profileConfiguration, /curator:\n  enabled: false/u);
  await access(join(result.stage, "skills", "project-work", "SKILL.md"));
  await access(join(result.stage, "host", "src", "hermes-dws-sidecar.mjs"));
  assert.match(
    await readFile(join(result.stage, "host", "bin", "codex"), "utf8"),
    /foursday-codex-proxy\.mjs/u,
  );
  await assert.rejects(access(join(result.stage, "host", "src", "worker.mjs")));
  assert.match(
    await readFile(join(result.stage, "scripts", "foursday-memory-promoter.sh"), "utf8"),
    /--quiet-idle/u,
  );
  const committed = await stageFoursdayProfileDistribution({
    layout,
    version: "0.6.0",
    hermesVersion: "0.20.4",
    foursdayCommit: "f".repeat(40),
    hermesCommit: "e".repeat(40),
    hermesRepository: "https://github.com/NousResearch/hermes-agent.git",
  });
  const release = JSON.parse(
    await readFile(join(committed.stage, "foursday-release.json"), "utf8"),
  );
  assert.equal(release.foursdayCommit, "f".repeat(40));
  assert.equal(release.hermesCommit, "e".repeat(40));
  assert.equal(release.hermesRepository, "https://github.com/NousResearch/hermes-agent.git");
});

test("native apply verifies installer digest, installs profile, doctors plugins and keeps Gateway stopped", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-apply-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("#!/bin/sh\n" + "#".repeat(10_000));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const calls = [];
  const run = async (path, args) => {
    calls.push([path, args]);
    if (path === "/usr/bin/git" && args.includes("rev-parse")) {
      return { stdout: `${"e".repeat(40)}\n` };
    }
    if (path === "/usr/bin/git" && args.includes("get-url")) {
      return { stdout: "https://github.com/NousResearch/hermes-agent.git\n" };
    }
    if (path === "/usr/bin/git" && args.includes("status")) return { stdout: "" };
    if (path === "/usr/bin/git" && args.includes("ls-files")) {
      return { stdout: "H agent/conversation_loop.py\n" };
    }
    if (path === "/bin/bash") {
      await mkdir(join(root, ".local", "bin"), { recursive: true });
      await writeFile(layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
      await writeSingleLoopRuntime(layout);
      return { stdout: "" };
    }
    if (path === layout.hermesCommand && args[0] === "--version") {
      return { stdout: "Hermes Agent 0.20.4\n" };
    }
    if (path === layout.hermesCommand && args[0] === "profile") {
      await writeFile(layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
      await writeSingleLoopProfile(layout);
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  const result = await runFoursdayNativeHermesInstall({
    apply: true,
    lock: lock(body),
    layout,
    foursdayVersion: "0.6.0",
    run,
    fetchImpl: async () => new Response(body, { status: 200 }),
    stageProfile: async () => ({ stage: join(root, "stage") }),
    installHostDependencies: async () => {},
    bootstrapCheckout: async () => {},
  });
  assert.equal(result.installed, true);
  assert.equal(result.gatewayInstalled, false);
  assert.equal(result.gatewayStarted, false);
  const installerCall = calls.find(([path]) => path === "/bin/bash");
  for (const flag of [
    "--skip-setup",
    "--skip-browser",
    "--skip-computer-use",
    "--no-skills",
    "--non-interactive",
  ]) assert.ok(installerCall[1].includes(flag), `missing minimal installer flag: ${flag}`);
  assert.deepEqual(calls.filter(([path]) => path !== "/usr/bin/git").map(([path, args]) => [path, args[0]]), [
    ["/bin/bash", calls[0][1][0]],
    [layout.hermesCommand, "--version"],
    [layout.hermesCommand, "profile"],
    [layout.hermesCommand, "profile"],
    [layout.hermesCommand, "profile"],
    [layout.hermesCommand, "profile"],
    [layout.profileAlias, "plugins"],
  ]);
});

test("interrupted native install journal restores the previous CLI on the next run", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-journal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const backup = `${layout.installDirectory}.backup`;
  await mkdir(layout.installDirectory, { recursive: true });
  await mkdir(backup);
  await writeFile(join(layout.installDirectory, "partial"), "partial");
  await writeFile(join(backup, "working"), "working");
  await mkdir(layout.hermesHome, { recursive: true });
  await writeFile(join(layout.hermesHome, ".foursday-native-install.json"), JSON.stringify({
    schema: "foursday-native-hermes-install-journal/v1",
    installDirectory: layout.installDirectory,
    backup,
    targetCommit: "e".repeat(40),
    createdAt: "2026-08-20T00:00:00Z",
  }), { mode: 0o600 });
  const result = await recoverInterruptedNativeHermesInstall(layout);
  assert.equal(result.recovered, true);
  await access(join(layout.installDirectory, "working"));
  await access(join(result.interrupted, "partial"));
  await assert.rejects(access(join(layout.hermesHome, ".foursday-native-install.json")));
});

test("native install refuses a changed official installer before running it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-digest-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let ran = false;
  await assert.rejects(
    runFoursdayNativeHermesInstall({
      apply: true,
      lock: { ...lock("x".repeat(10_000)), installerSha256: "0".repeat(64) },
      layout: foursdayNativeHermesLayout({ userHome: root, projectRoot: root }),
      foursdayVersion: "0.6.0",
      run: async () => { ran = true; return { stdout: "" }; },
      fetchImpl: async () => new Response("x".repeat(10_000), { status: 200 }),
    }),
    /digest mismatch/u,
  );
  assert.equal(ran, false);
});

test("untracked native installs are moved to a recoverable backup only after exact installer identity", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-existing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("#!/bin/sh\n" + "#".repeat(10_000));
  const upstream = lock(body);
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await mkdir(join(layout.installDirectory, "scripts"), { recursive: true, mode: 0o700 });
  await chmod(join(root, ".hermes"), 0o700);
  await writeFile(join(layout.installDirectory, "scripts", "install.sh"), body);
  const result = await prepareNativeHermesInstallDirectory(layout, upstream);
  assert.ok(result.backup);
  await access(join(result.backup, "scripts", "install.sh"));
  await assert.rejects(access(layout.installDirectory));
});

test("native profile update refuses a running Gateway before changing files", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-running-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await mkdir(layout.profileDirectory, { recursive: true });
  await mkdir(join(root, ".local", "bin"), { recursive: true });
  await writeFile(layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
  await writeSingleLoopRuntime(layout);
  await writeSingleLoopProfile(layout);
  const calls = [];
  await assert.rejects(
    finishFoursdayNativeProfileInstall({
      layout,
      lock: {
        version: "0.20.4",
        commit: "e".repeat(40),
        repository: "https://github.com/NousResearch/hermes-agent.git",
      },
      foursdayVersion: "0.6.0",
      run: async (path, args) => {
        calls.push([path, args]);
        if (args[0] === "--version") return { stdout: "Hermes Agent 0.20.4\n" };
        if (path === "/usr/bin/git" && args.includes("rev-parse")) return { stdout: `${"e".repeat(40)}\n` };
        if (path === "/usr/bin/git" && args.includes("get-url")) return { stdout: "https://github.com/NousResearch/hermes-agent.git\n" };
        if (path === "/usr/bin/git" && args.includes("status")) return { stdout: "" };
        if (path === "/usr/bin/git" && args.includes("ls-files")) return { stdout: "H agent/conversation_loop.py\n" };
        if (args[0] === "gateway") return { stdout: "Gateway is running\n" };
        throw new Error("must not mutate profile");
      },
      stageProfile: async () => { throw new Error("must not stage"); },
    }),
    /Stop the Foursday Gateway/u,
  );
  assert.equal(calls.filter(([, args]) => args[0] === "profile").length, 0);
});

test("failed native profile update restores the official exported profile", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-rollback-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await mkdir(layout.profileDirectory, { recursive: true });
  await mkdir(join(root, ".local", "bin"), { recursive: true });
  await writeFile(layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
  await writeSingleLoopRuntime(layout);
  await writeSingleLoopProfile(layout);
  const calls = [];
  await assert.rejects(
    finishFoursdayNativeProfileInstall({
      layout,
      lock: {
        version: "0.20.4",
        commit: "e".repeat(40),
        repository: "https://github.com/NousResearch/hermes-agent.git",
      },
      foursdayVersion: "0.6.0",
      run: async (path, args) => {
        calls.push([path, args]);
        if (args[0] === "--version") return { stdout: "Hermes Agent 0.20.4\n" };
        if (path === "/usr/bin/git" && args.includes("rev-parse")) return { stdout: `${"e".repeat(40)}\n` };
        if (path === "/usr/bin/git" && args.includes("get-url")) return { stdout: "https://github.com/NousResearch/hermes-agent.git\n" };
        if (path === "/usr/bin/git" && args.includes("status")) return { stdout: "" };
        if (path === "/usr/bin/git" && args.includes("ls-files")) return { stdout: "H agent/conversation_loop.py\n" };
        if (args[0] === "gateway") return { stdout: "Gateway is not running\n" };
        if (args[0] === "profile" && args[1] === "export") {
          await writeFile(args.at(-1), "private profile backup", { mode: 0o600 });
          return { stdout: "" };
        }
        if (args[0] === "profile" && args[1] === "update") {
          throw new Error("profile update failed");
        }
        return { stdout: "" };
      },
      stageProfile: async () => ({ stage: join(root, "stage") }),
      installHostDependencies: async () => {},
    }),
    /profile update failed/u,
  );
  const profileActions = calls
    .filter(([, args]) => args[0] === "profile")
    .map(([, args]) => args[1]);
  assert.deepEqual(profileActions, [
    "export", "install", "update", "alias", "delete", "import", "alias",
  ]);
});
