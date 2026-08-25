import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const componentPluginDirectories = Object.freeze([
  "dws_personal",
  "project_router",
]);
const pluginDirectories = Object.freeze([
  "foursday_work_twin",
]);
const hostEntrypoints = Object.freeze([
  "src/dws-checkpoint-health.mjs",
  "src/hermes-dws-sidecar.mjs",
  "src/hermes-personal-memory-context.mjs",
  "src/hermes-memory-candidate-sidecar.mjs",
  "src/foursday-codex-mcp.mjs",
  "src/foursday-codex-proxy.mjs",
  "src/personal-gbrain-promoter.mjs",
]);
const optionalNodeDependencyPaths = Object.freeze([
  "node_modules",
  "apps/desktop/node_modules",
  "ui-tui/node_modules",
  "tests-js/node_modules",
]);

function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

export function foursdayNativeHermesLayout({
  userHome = homedir(),
  projectRoot,
  hermesHome = null,
} = {}) {
  const home = absolute(userHome, "user home");
  const project = absolute(projectRoot, "Foursday project root");
  const nativeHome = hermesHome
    ? absolute(hermesHome, "Hermes home")
    : join(home, ".hermes");
  return {
    userHome: home,
    projectRoot: project,
    hermesHome: nativeHome,
    installDirectory: join(nativeHome, "hermes-agent"),
    hermesCommand: join(home, ".local", "bin", "hermes"),
    profileAlias: join(home, ".local", "bin", "foursday-runtime"),
    profileStage: join(project, ".runtime", "hermes-profile", "foursday"),
    profileDirectory: join(nativeHome, "profiles", "foursday"),
  };
}

export async function inspectFoursdaySourceCommit(projectRoot, {
  run = execFileAsync,
  userHome = homedir(),
} = {}) {
  const root = absolute(projectRoot, "Foursday project root");
  const environment = {
    HOME: absolute(userHome, "user home"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  try {
    const [{ stdout: head }, { stdout: status }, { stdout: indexFlags }] = await Promise.all([
      run("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], {
        env: environment, timeout: 30_000, maxBuffer: 1024 * 1024,
      }),
      run("/usr/bin/git", [
        "-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
        "status", "--porcelain=v1", "--untracked-files=all",
      ], { env: environment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      run("/usr/bin/git", [
        "-C", root, "-c", "core.fsmonitor=false", "ls-files", "-v",
      ], { env: environment, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const commit = String(head).trim();
    if (!/^[a-f0-9]{40}$/u.test(commit)) return null;
    const hiddenIndexFlags = String(indexFlags).split("\n").some((line) =>
      /^[a-zS]/u.test(line));
    return String(status).trim() === "" && !hiddenIndexFlags ? commit : null;
  } catch {
    return null;
  }
}

export function officialHermesInstallerUrl(lock) {
  return `https://raw.githubusercontent.com/NousResearch/hermes-agent/${lock.commit}/${lock.installerPath}`;
}

export function officialHermesInstallerApiUrl(lock) {
  return `https://api.github.com/repos/NousResearch/hermes-agent/contents/${lock.installerPath}?ref=${lock.commit}`;
}

export function buildFoursdayNativeInstallPlan({
  lock,
  layout,
  installGateway = false,
} = {}) {
  if (!lock?.commit || !lock?.installerSha256 || !layout?.projectRoot) {
    throw new Error("Foursday native Hermes install plan is incomplete");
  }
  return {
    schema: "foursday-native-hermes-install/v1",
    upstream: {
      repository: lock.repository,
      release: lock.release,
      version: lock.version,
      commit: lock.commit,
      installerUrl: officialHermesInstallerUrl(lock),
      installerSha256: lock.installerSha256,
    },
    layout: {
      hermesHome: layout.hermesHome,
      installDirectory: layout.installDirectory,
      command: layout.hermesCommand,
      profile: "foursday",
      profileDirectory: layout.profileDirectory,
    },
    profile: {
      source: layout.profileStage,
      plugins: ["foursday_work_twin"],
      componentPlugins: [...componentPluginDirectories],
      skills: ["foursday-project-work"],
      hostBridge: "profile-owned Node sidecars with isolated production dependencies",
      gatewayInstallRequested: Boolean(installGateway),
      gatewayStartRequested: false,
    },
    messagesSent: 0,
    optionalNodeDependenciesPruned: false,
    productionWrite: false,
  };
}

async function assertRegularTree(path, root = path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("Foursday profile distribution cannot contain symlinks");
  }
  if (metadata.isFile()) {
    if (metadata.size > 2 * 1024 * 1024) {
      throw new Error("Foursday profile distribution file is too large");
    }
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Foursday profile distribution contains a special file");
  }
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(path)) {
    if (entry === "__pycache__" || entry.endsWith(".pyc")) continue;
    await assertRegularTree(join(path, entry), root);
  }
}

async function trustedRuntimeText(layout, relativePath) {
  const root = await realpath(layout.installDirectory);
  const path = join(root, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) {
    throw new Error("Embedded runtime contract source is unsafe");
  }
  const canonical = await realpath(path);
  if (relative(root, canonical).startsWith("..")) {
    throw new Error("Embedded runtime contract source escaped the locked checkout");
  }
  return readFile(canonical, "utf8");
}

export async function verifyFoursdaySingleAgentLoopContract(layout) {
  const [loop, codexRuntime, initialization, backgroundReview, titleGenerator, curator] = await Promise.all([
    trustedRuntimeText(layout, "agent/conversation_loop.py"),
    trustedRuntimeText(layout, "agent/codex_runtime.py"),
    trustedRuntimeText(layout, "agent/agent_init.py"),
    trustedRuntimeText(layout, "agent/background_review.py"),
    trustedRuntimeText(layout, "agent/title_generator.py"),
    trustedRuntimeText(layout, "agent/curator.py"),
  ]);
  const checks = [
    /if agent\.api_mode == ["']codex_app_server["']:[\s\S]{0,300}return agent\._run_codex_app_server_turn\(/u.test(loop),
    /Hands the entire turn to a `codex[\s\S]{0,160}app-server` subprocess/u.test(codexRuntime),
    /CodexAppServerSession/u.test(codexRuntime),
    /auto_approve_exec=auto_approve_requests/u.test(codexRuntime),
    /is_approval_bypass_active/u.test(codexRuntime),
    /mem_config\.get\(["']nudge_interval["']/u.test(initialization),
    /skills_config\.get\(["']creation_nudge_interval["']/u.test(initialization),
    /task\.get\(["']enabled["']\), default=True/u.test(backgroundReview),
    /title_config\.get\(["']enabled["']\), default=True/u.test(titleGenerator),
    /cfg\.get\(["']enabled["'], True\)/u.test(curator),
  ];
  if (checks.some((valid) => !valid)) {
    throw new Error("Locked embedded runtime no longer satisfies the single Codex loop contract");
  }
  return { valid: true, runtime: "codex_app_server", backgroundLoopsConfigurable: true };
}

export async function assertFoursdayEmbeddedRuntimeIdentity(layout, {
  expectedCommit,
  expectedRepository,
  run = execFileAsync,
} = {}) {
  const git = (...args) => run("/usr/bin/git", [
    "-C", layout.installDirectory,
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], {
    env: nativeEnvironment(layout),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const [{ stdout: head }, { stdout: remote }, { stdout: status }, { stdout: indexFlags }] =
    await Promise.all([
      git("rev-parse", "HEAD"),
      git("remote", "get-url", "origin"),
      git("status", "--porcelain=v1", "--untracked-files=no"),
      git("ls-files", "-v"),
    ]);
  const changes = String(status).split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const allowedInstallerNoise = /^ M contributors\/emails\/agent@[^/\s]+\.local$/u;
  if (
    String(head).trim() !== expectedCommit ||
    String(remote).trim() !== expectedRepository ||
    changes.some((line) => !allowedInstallerNoise.test(line)) ||
    String(indexFlags).split("\n").some((line) => /^[a-zS]/u.test(line))
  ) throw new Error("Installed embedded runtime does not match its immutable Foursday lock");
  return { commit: expectedCommit, installerNoiseFiles: changes.length };
}

async function verifyInstalledSingleLoopProfile(layout) {
  const configPath = join(layout.profileDirectory, "config.yaml");
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Installed Foursday profile config is unsafe");
  }
  const config = await readFile(configPath, "utf8");
  for (const required of [
    "openai_runtime: codex_app_server",
    "approvals:\n  mode: 'off'",
    "display:\n  show_commentary: false\n  tool_progress: off\n  interim_assistant_messages: false\n  long_running_notifications: false\n  busy_ack_enabled: false",
    "streaming:\n  enabled: false",
    "background_review:\n    enabled: false",
    "title_generation:\n    enabled: false",
    "memory_enabled: false",
    "user_profile_enabled: false",
    "nudge_interval: 0",
    "creation_nudge_interval: 0",
    "curator:\n  enabled: false",
  ]) {
    if (!config.includes(required)) {
      throw new Error("Installed Foursday profile could enable a second agent loop");
    }
  }
  return { valid: true };
}

export async function collectFoursdayHostModules(projectRoot) {
  const root = absolute(projectRoot, "Foursday project root");
  const sourceRoot = join(root, "src");
  const queue = hostEntrypoints.map((path) => join(root, path));
  const seen = new Set();
  const importPattern = /\b(?:from\s+|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu;
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Foursday host module graph contains an unsafe file");
    }
    const difference = relative(sourceRoot, path);
    if (difference.startsWith("..") || isAbsolute(difference)) {
      throw new Error("Foursday host module graph escaped src");
    }
    seen.add(path);
    const content = await readFile(path, "utf8");
    for (const match of content.matchAll(importPattern)) {
      const dependency = resolve(dirname(path), match[1]);
      const dependencyPath = dependency.endsWith(".mjs") ? dependency : `${dependency}.mjs`;
      const dependencyDifference = relative(sourceRoot, dependencyPath);
      if (dependencyDifference.startsWith("..") || isAbsolute(dependencyDifference)) {
        throw new Error("Foursday host module import escaped src");
      }
      queue.push(dependencyPath);
    }
  }
  return [...seen].sort();
}

function profileConfig() {
  return [
    "model:",
    "  provider: openai-codex",
    "  default: gpt-5.6-sol",
    "  openai_runtime: codex_app_server",
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
    "auxiliary:",
    "  background_review:",
    "    enabled: false",
    "  title_generation:",
    "    enabled: false",
    "memory:",
    "  memory_enabled: false",
    "  user_profile_enabled: false",
    "  nudge_interval: 0",
    "  flush_min_turns: 0",
    "skills:",
    "  creation_nudge_interval: 0",
    "curator:",
    "  enabled: false",
    "plugins:",
    "  enabled:",
    "    - foursday-work-twin",
    "  entries:",
    "    foursday-work-twin:",
    "      allow_tool_override: false",
    "",
  ].join("\n");
}

function distributionManifest({ version, hermesVersion }) {
  return [
    "name: foursday",
    `version: ${version}`,
    "description: 'Personal-memory-driven work twin for real projects'",
    `hermes_requires: '==${hermesVersion}'`,
    "author: Foursday",
    "license: MIT",
    "distribution_owned:",
    "  - SOUL.md",
    "  - config.yaml",
    "  - skills",
    "  - plugins",
    "  - host",
    "  - scripts",
    "  - distribution.yaml",
    "  - foursday-release.json",
    "env_requires:",
    "  - name: FOURSDAY_PRODUCTION_CONFIG",
    "    description: Private host-side Foursday config path",
    "    required: true",
    "  - name: FOURSDAY_PROJECT_REGISTRY",
    "    description: Private exact project registry path",
    "    required: true",
    "  - name: DWS_PERSONAL_ALLOWED_USERS",
    "    description: Trusted DingTalk staff IDs",
    "    required: true",
    "",
  ].join("\n");
}

export async function stageFoursdayProfileDistribution({
  layout,
  version,
  hermesVersion,
  foursdayCommit = null,
  hermesCommit = null,
  hermesRepository = null,
} = {}) {
  const projectRoot = absolute(layout.projectRoot, "Foursday project root");
  const stage = absolute(layout.profileStage, "Foursday profile stage");
  const stageParent = dirname(stage);
  await mkdir(stageParent, { recursive: true, mode: 0o700 });
  await chmod(stageParent, 0o700);
  const temporary = `${stage}.staging-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { mode: 0o700 });
  try {
    await cp(join(projectRoot, "distribution", "profile", "SOUL.md"), join(temporary, "SOUL.md"), {
      errorOnExist: true,
      force: false,
    });
    await cp(join(projectRoot, "distribution", "skills"), join(temporary, "skills"), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !source.includes("/__pycache__") && !source.endsWith(".pyc"),
    });
    await mkdir(join(temporary, "host"), { mode: 0o700 });
    await mkdir(join(temporary, "host", "bin"), { mode: 0o700 });
    const hostModules = await collectFoursdayHostModules(projectRoot);
    for (const source of hostModules) {
      const destination = join(temporary, "host", relative(projectRoot, source));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await cp(source, destination, { errorOnExist: true, force: false });
    }
    await writeFile(join(temporary, "host", "bin", "codex"), [
      "#!/bin/sh",
      'exec "$FOURSDAY_NODE_PATH" "$(dirname "$0")/../src/foursday-codex-proxy.mjs" "$@"',
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(join(temporary, "host", "bin", "codex"), 0o700);
    await Promise.all([
      cp(join(projectRoot, "distribution", "host", "package.json"), join(temporary, "host", "package.json"), {
        errorOnExist: true,
        force: false,
      }),
      cp(join(projectRoot, "distribution", "host", "package-lock.json"), join(temporary, "host", "package-lock.json"), {
        errorOnExist: true,
        force: false,
      }),
    ]);
    await mkdir(join(temporary, "host", "scripts"), { mode: 0o700 });
    await cp(
      join(projectRoot, "scripts", "运行个人gbrain记忆晋升.mjs"),
      join(temporary, "host", "scripts", "运行个人gbrain记忆晋升.mjs"),
      { errorOnExist: true, force: false },
    );
    await mkdir(join(temporary, "scripts"), { mode: 0o700 });
    await writeFile(join(temporary, "scripts", "foursday-memory-promoter.sh"), [
      "#!/bin/bash",
      "set -euo pipefail",
      ": \"${FOURSDAY_NODE_PATH:?FOURSDAY_NODE_PATH is required}\"",
      "exec \"$FOURSDAY_NODE_PATH\" \"$HERMES_HOME/host/scripts/运行个人gbrain记忆晋升.mjs\" --once --quiet-idle",
      "",
    ].join("\n"), { mode: 0o700 });
    await mkdir(join(temporary, "plugins"), { mode: 0o700 });
    for (const name of pluginDirectories) {
      const source = join(projectRoot, "distribution", "plugins", name);
      await assertRegularTree(source);
      await cp(source, join(temporary, "plugins", name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (path) => !path.includes("/__pycache__") && !path.endsWith(".pyc"),
      });
    }
    const componentRoot = join(
      temporary,
      "plugins", "foursday_work_twin", "components",
    );
    await mkdir(componentRoot, { mode: 0o700 });
    await writeFile(join(componentRoot, "__init__.py"), "# Foursday components\n", {
      mode: 0o600,
    });
    for (const name of componentPluginDirectories) {
      const source = join(projectRoot, "distribution", "plugins", name);
      await assertRegularTree(source);
      await cp(source, join(componentRoot, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (path) => !path.includes("/__pycache__") && !path.endsWith(".pyc"),
      });
    }
    await Promise.all([
      writeFile(join(temporary, "config.yaml"), profileConfig(), { mode: 0o600 }),
      writeFile(
        join(temporary, "distribution.yaml"),
        distributionManifest({ version, hermesVersion }),
        { mode: 0o600 },
      ),
      writeFile(
        join(temporary, "foursday-release.json"),
        `${JSON.stringify({
          schema: "foursday-profile-release/v1",
          foursdayVersion: version,
          foursdayCommit,
          hermesVersion,
          hermesCommit,
          hermesRepository,
        }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    const previous = `${stage}.previous`;
    await rm(previous, { recursive: true, force: true });
    const existing = await lstat(stage).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("Foursday profile stage is unsafe");
      }
      await rename(stage, previous);
    }
    await rename(temporary, stage);
    return {
      stage,
      pluginCount: pluginDirectories.length,
      componentPluginCount: componentPluginDirectories.length,
      hostModuleCount: hostModules.length,
      previousPreserved: Boolean(existing),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function nativeEnvironment(layout) {
  return {
    HOME: layout.userHome,
    HERMES_HOME: layout.hermesHome,
    PATH: `${dirname(layout.hermesCommand)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
}

export async function downloadVerifiedInstaller(lock, {
  fetchImpl = fetch,
  fallbackPath = null,
  environment = process.env,
} = {}) {
  const url = officialHermesInstallerUrl(lock);
  let body;
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("download failed");
    body = Buffer.from(await response.arrayBuffer());
  } catch {
    try {
      const token = String(environment.GITHUB_TOKEN ?? "").trim();
      const response = await fetchImpl(officialHermesInstallerApiUrl(lock), {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "foursday-installer",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) throw new Error("API download failed");
      const payload = await response.json();
      if (
        payload?.type !== "file" ||
        payload?.encoding !== "base64" ||
        typeof payload?.content !== "string" ||
        payload.content.length > 4 * 1024 * 1024
      ) throw new Error("API installer payload is invalid");
      body = Buffer.from(payload.content.replaceAll(/\s/gu, ""), "base64");
    } catch {
      if (!fallbackPath) throw new Error("Official Hermes installer download failed");
      body = await readFile(fallbackPath);
    }
  }
  if (body.length < 10_000 || body.length > 2 * 1024 * 1024) {
    throw new Error("Official Hermes installer size is invalid");
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== lock.installerSha256) {
    throw new Error("Official Hermes installer digest mismatch");
  }
  const directory = await mkdtemp(join(tmpdir(), "foursday-hermes-installer-"));
  const path = join(directory, "install.sh");
  await writeFile(path, body, { mode: 0o700 });
  return { path, directory, digest };
}

export async function prepareNativeHermesInstallDirectory(layout, lock) {
  const parent = dirname(layout.installDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o077) !== 0 || await realpath(parent) !== parent
  ) throw new Error("Native Hermes install parent is unsafe");
  await chmod(parent, 0o700);
  const metadata = await lstat(layout.installDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return { backup: null, existingGitCheckout: false };
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Native Hermes install directory is unsafe");
  }
  const git = await lstat(join(layout.installDirectory, ".git")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (git?.isDirectory()) return { backup: null, existingGitCheckout: true };
  const installer = await readFile(join(layout.installDirectory, lock.installerPath));
  const digest = createHash("sha256").update(installer).digest("hex");
  if (digest !== lock.installerSha256) {
    throw new Error("Existing native Hermes install cannot be identified safely");
  }
  const backup = `${layout.installDirectory}.pre-foursday-${new Date()
    .toISOString().replace(/[:.]/gu, "-")}`;
  await rename(layout.installDirectory, backup);
  return { backup, existingGitCheckout: false };
}

export async function pruneFoursdayOptionalNodeDependencies(layout, {
  apply = false,
  verify = async () => {},
} = {}) {
  const targets = [];
  for (const relativePath of optionalNodeDependencyPaths) {
    const path = join(layout.installDirectory, relativePath);
    const metadata = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) continue;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Optional runtime dependency target is unsafe");
    }
    targets.push({ relativePath, path });
  }
  const plan = {
    schema: "foursday-runtime-prune/v1",
    apply,
    targets: targets.map(({ relativePath }) => relativePath),
    sourceFilesRemoved: 0,
    gitTrackedFilesRemoved: 0,
  };
  if (!apply || targets.length === 0) return plan;
  const moved = [];
  try {
    for (const target of targets) {
      const backup = `${target.path}.foursday-prune-${process.pid}`;
      if (await lstat(backup).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })) {
        throw new Error("Optional runtime dependency backup already exists");
      }
      await rename(target.path, backup);
      moved.push({ ...target, backup });
    }
    await verify();
    for (const { backup } of moved) await rm(backup, { recursive: true, force: false });
    return { ...plan, pruned: true, verified: true };
  } catch (error) {
    for (const { path, backup } of moved.reverse()) {
      const backupMetadata = await lstat(backup).catch((failure) => {
        if (failure.code === "ENOENT") return null;
        throw failure;
      });
      if (backupMetadata) await rename(backup, path);
    }
    throw error;
  }
}

async function verifyPrunedFoursdayRuntime(layout, { run = execFileAsync } = {}) {
  await run(layout.hermesCommand, ["--version"], {
    cwd: layout.projectRoot,
    env: nativeEnvironment(layout),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  await run(layout.profileAlias, [
    "plugins", "doctor",
    join(layout.profileDirectory, "plugins", "foursday_work_twin"),
    "--ci",
  ], {
    cwd: layout.profileDirectory,
    env: { ...nativeEnvironment(layout), HERMES_HOME: layout.profileDirectory },
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const { stdout } = await run("/usr/bin/git", [
    "-C", layout.installDirectory,
    "ls-files", "--",
    ...optionalNodeDependencyPaths,
  ], {
    env: nativeEnvironment(layout), timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (String(stdout).trim()) throw new Error("Runtime pruning target contains tracked upstream files");
}

function installJournalPath(layout) {
  return join(layout.hermesHome, ".foursday-native-install.json");
}

async function writeInstallJournal(layout, document) {
  await mkdir(layout.hermesHome, { recursive: true, mode: 0o700 });
  await chmod(layout.hermesHome, 0o700);
  const path = installJournalPath(layout);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  return path;
}

export async function recoverInterruptedNativeHermesInstall(layout) {
  const path = installJournalPath(layout);
  const metadata = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return { recovered: false };
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Native Hermes install journal is unsafe");
  }
  const journal = JSON.parse(await readFile(path, "utf8"));
  if (
    journal?.schema !== "foursday-native-hermes-install-journal/v1" ||
    journal.installDirectory !== layout.installDirectory ||
    typeof journal.backup !== "string" ||
    dirname(journal.backup) !== dirname(layout.installDirectory)
  ) throw new Error("Native Hermes install journal identity mismatch");
  const backup = await lstat(journal.backup).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!backup?.isDirectory() || backup.isSymbolicLink()) {
    throw new Error("Native Hermes install recovery backup is unavailable");
  }
  const current = await lstat(layout.installDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let interrupted = null;
  if (current) {
    interrupted = `${layout.installDirectory}.interrupted-${new Date()
      .toISOString().replace(/[:.]/gu, "-")}`;
    await rename(layout.installDirectory, interrupted);
  }
  await rename(journal.backup, layout.installDirectory);
  await unlink(path);
  return { recovered: true, interrupted };
}

export async function bootstrapOfficialHermesCheckout(layout, lock, {
  run = execFileAsync,
} = {}) {
  const environment = {
    HOME: layout.userHome,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  const mirror = join(layout.projectRoot, ".runtime", "hermes-poc", "upstream");
  const mirrorGit = await lstat(join(mirror, ".git")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let usedLocalMirror = false;
  if (mirrorGit?.isDirectory()) {
    const [{ stdout: remote }, { stdout: status }] = await Promise.all([
      run("/usr/bin/git", ["-C", mirror, "remote", "get-url", "origin"], {
        env: environment, timeout: 30_000, maxBuffer: 1024 * 1024,
      }),
      run("/usr/bin/git", ["-C", mirror, "status", "--porcelain"], {
        env: environment, timeout: 30_000, maxBuffer: 1024 * 1024,
      }),
    ]);
    const installer = await readFile(join(mirror, lock.installerPath));
    const license = await readFile(join(mirror, "LICENSE"));
    if (
      String(remote).trim() !== lock.repository ||
      String(status).trim() ||
      createHash("sha256").update(installer).digest("hex") !== lock.installerSha256 ||
      createHash("sha256").update(license).digest("hex") !== lock.licenseSha256
    ) throw new Error("Local Hermes upstream mirror identity mismatch");
    await run("/usr/bin/git", ["-C", mirror, "cat-file", "-e", `${lock.commit}^{commit}`], {
      env: environment, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const cache = join(layout.projectRoot, ".runtime", "hermes-native-cache.git");
    const cacheMetadata = await lstat(cache).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!cacheMetadata) {
      await run("/usr/bin/git", [
        "clone", "--bare", "--local", "--no-hardlinks", mirror, cache,
      ], {
        cwd: dirname(cache),
        env: environment,
        timeout: 10 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } else if (!cacheMetadata.isDirectory() || cacheMetadata.isSymbolicLink()) {
      throw new Error("Local Hermes upstream cache is unsafe");
    }
    await run("/usr/bin/git", [
      "--git-dir", cache, "update-ref", "refs/heads/main", lock.commit,
    ], { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 });
    await run("/usr/bin/git", [
      "-c", "core.hooksPath=/dev/null",
      "clone", "--local", "--no-hardlinks", "--branch", "main",
      cache, layout.installDirectory,
    ], {
      cwd: dirname(layout.installDirectory),
      env: environment,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    usedLocalMirror = true;
  } else {
    await run("/usr/bin/git", [
      "-c", "core.hooksPath=/dev/null",
      "clone", "--filter=blob:none", "--single-branch", "--branch", "main",
      "--no-checkout", lock.repository, layout.installDirectory,
    ], {
      cwd: dirname(layout.installDirectory),
      env: environment,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await run("/usr/bin/git", [
      "-c", "core.hooksPath=/dev/null",
      "-C", layout.installDirectory,
      "fetch", "--depth", "1", "origin", lock.commit,
    ], { env: environment, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  }
  await run("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null",
    "-C", layout.installDirectory,
    "checkout", "--detach", lock.commit,
  ], { env: environment, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const { stdout: head } = await run("/usr/bin/git", [
    "-C", layout.installDirectory, "rev-parse", "HEAD",
  ], { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (String(head).trim() !== lock.commit) {
    throw new Error("Native Hermes HTTPS bootstrap did not reach the locked commit");
  }
  return {
    commit: lock.commit,
    repository: usedLocalMirror ? mirror : lock.repository,
    usedLocalMirror,
  };
}

export async function runFoursdayNativeHermesInstall({
  apply = false,
  installGateway = false,
  profileOnly = false,
  lock,
  layout,
  foursdayVersion,
  foursdayCommit = null,
  run = execFileAsync,
  fetchImpl = fetch,
  stageProfile = stageFoursdayProfileDistribution,
  installHostDependencies = null,
  bootstrapCheckout = bootstrapOfficialHermesCheckout,
} = {}) {
  const plan = buildFoursdayNativeInstallPlan({ lock, layout, installGateway });
  if (!apply) return { ...plan, apply: false, installed: false };
  const env = nativeEnvironment(layout);
  if (profileOnly) {
    const [{ stdout: head }, { stdout: remote }] = await Promise.all([
      run("/usr/bin/git", ["-C", layout.installDirectory, "rev-parse", "HEAD"], {
        env, timeout: 30_000, maxBuffer: 1024 * 1024,
      }),
      run("/usr/bin/git", ["-C", layout.installDirectory, "remote", "get-url", "origin"], {
        env, timeout: 30_000, maxBuffer: 1024 * 1024,
      }),
    ]);
    if (String(head).trim() !== lock.commit || String(remote).trim() !== lock.repository) {
      throw new Error("Profile-only recovery requires the exact native Hermes checkout");
    }
    const finished = await finishFoursdayNativeProfileInstall({
      layout,
      lock,
      foursdayVersion,
      foursdayCommit,
      installGateway,
      run,
      env,
      stageProfile,
      installHostDependencies,
    });
    const pruning = await pruneFoursdayOptionalNodeDependencies(layout, {
      apply: true,
      verify: () => verifyPrunedFoursdayRuntime(layout, { run }),
    });
    await unlink(installJournalPath(layout)).catch(() => {});
    return {
      ...plan, ...finished, apply: true, profileOnly: true,
      optionalNodeDependenciesPruned: pruning.pruned === true,
      prunedTargets: pruning.targets,
    };
  }
  await recoverInterruptedNativeHermesInstall(layout);
  const fallbackCandidates = [
    join(layout.installDirectory, lock.installerPath),
    join(layout.projectRoot, ".runtime", "hermes-poc", "upstream", lock.installerPath),
  ];
  let fallbackInstaller = null;
  for (const candidate of fallbackCandidates) {
    if (await access(candidate, constants.R_OK).then(() => true).catch(() => false)) {
      fallbackInstaller = candidate;
      break;
    }
  }
  const installer = await downloadVerifiedInstaller(lock, {
    fetchImpl,
    fallbackPath: fallbackInstaller,
  });
  const prepared = await prepareNativeHermesInstallDirectory(layout, lock);
  if (prepared.backup) {
    await writeInstallJournal(layout, {
      schema: "foursday-native-hermes-install-journal/v1",
      installDirectory: layout.installDirectory,
      backup: prepared.backup,
      targetCommit: lock.commit,
      createdAt: new Date().toISOString(),
    });
  }
  try {
    const bootstrap = !prepared.existingGitCheckout
      ? (await bootstrapCheckout(layout, lock, { run }) ?? {})
      : { usedLocalMirror: false };
    await run("/bin/bash", [
      installer.path,
      "--commit", lock.commit,
      "--force-commit",
      "--dir", layout.installDirectory,
      "--hermes-home", layout.hermesHome,
      "--skip-setup",
      "--skip-browser",
      "--skip-computer-use",
      "--no-skills",
      "--non-interactive",
    ], { cwd: layout.projectRoot, env, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (bootstrap.usedLocalMirror) {
      await run("/usr/bin/git", [
        "-C", layout.installDirectory, "remote", "set-url", "origin", lock.repository,
      ], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    }
    const { stdout: installedHead } = await run("/usr/bin/git", [
      "-C", layout.installDirectory, "rev-parse", "HEAD",
    ], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (String(installedHead).trim() !== lock.commit) {
      throw new Error("Native Hermes install did not remain on the locked commit");
    }
  } catch (error) {
    if (prepared.backup) {
      const partial = await lstat(layout.installDirectory).catch((failure) => {
        if (failure.code === "ENOENT") return null;
        throw failure;
      });
      if (partial) {
        await rename(
          layout.installDirectory,
          `${layout.installDirectory}.failed-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
        );
      }
      await rename(prepared.backup, layout.installDirectory);
      await unlink(installJournalPath(layout)).catch(() => {});
    }
    throw error;
  } finally {
    await rm(installer.directory, { recursive: true, force: true });
  }
  const finished = await finishFoursdayNativeProfileInstall({
    layout,
    lock,
    foursdayVersion,
    foursdayCommit,
    installGateway,
    run,
    env,
    stageProfile,
    installHostDependencies,
  });
  const pruning = await pruneFoursdayOptionalNodeDependencies(layout, {
    apply: true,
    verify: () => verifyPrunedFoursdayRuntime(layout, { run }),
  });
  if (prepared.backup) await unlink(installJournalPath(layout)).catch(() => {});
  return {
    ...plan,
    ...finished,
    optionalNodeDependenciesPruned: pruning.pruned === true,
    prunedTargets: pruning.targets,
    apply: true,
    previousUntrackedInstallBackedUp: Boolean(prepared.backup),
  };
}

export async function finishFoursdayNativeProfileInstall({
  layout,
  lock,
  foursdayVersion,
  foursdayCommit = null,
  installGateway = false,
  run = execFileAsync,
  env = nativeEnvironment(layout),
  stageProfile = stageFoursdayProfileDistribution,
  installHostDependencies = null,
} = {}) {
  await access(layout.hermesCommand, constants.X_OK);
  const { stdout: versionOutput } = await run(layout.hermesCommand, ["--version"], {
    cwd: layout.projectRoot,
    env,
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
  if (!String(versionOutput).includes(lock.version)) {
    throw new Error("Native Hermes version does not match the compatibility lock");
  }
  await assertFoursdayEmbeddedRuntimeIdentity(layout, {
    expectedCommit: lock.commit,
    expectedRepository: lock.repository,
    run,
  });
  await verifyFoursdaySingleAgentLoopContract(layout);
  const existingProfile = await lstat(layout.profileDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let profileBackup = null;
  if (existingProfile) {
    if (!existingProfile.isDirectory() || existingProfile.isSymbolicLink()) {
      throw new Error("Existing Foursday profile is unsafe");
    }
    const { stdout: gatewayStatus } = await run(layout.profileAlias, ["gateway", "status"], {
      cwd: layout.projectRoot,
      env,
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    });
    if (/\brunning\b/iu.test(String(gatewayStatus)) && !/\bnot\s+running\b/iu.test(String(gatewayStatus))) {
      throw new Error("Stop the Foursday Gateway before updating its native profile");
    }
    const directory = await mkdtemp(join(tmpdir(), "foursday-profile-backup-"));
    await chmod(directory, 0o700);
    const archive = join(directory, "foursday.tar.gz");
    try {
      await run(layout.hermesCommand, [
        "profile", "export", "foursday", "--output", archive,
      ], { cwd: layout.projectRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const archiveMetadata = await lstat(archive);
      if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.size < 1) {
        throw new Error("Foursday profile backup is invalid");
      }
      await chmod(archive, 0o600);
      profileBackup = { directory, archive };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  const profile = await stageProfile({
    layout,
    version: foursdayVersion,
    hermesVersion: lock.version,
    foursdayCommit,
    hermesCommit: lock.commit,
    hermesRepository: lock.repository,
  });
  try {
    await run(layout.hermesCommand, [
      "profile", "install", profile.stage,
      "--name", "foursday", "--force", "--yes",
    ], { cwd: layout.projectRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    await run(layout.hermesCommand, [
      "profile", "update", "foursday", "--force-config", "--yes",
    ], { cwd: layout.projectRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    await run(layout.hermesCommand, [
      "profile", "alias", "foursday", "--name", "foursday-runtime",
    ], { cwd: layout.projectRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    await access(layout.profileAlias, constants.X_OK);
    await run(layout.hermesCommand, [
      "profile", "alias", "foursday", "--remove", "--name", "hermes-foursday",
    ], { cwd: layout.projectRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024 }).catch(() => {});
    await verifyInstalledSingleLoopProfile(layout);
    if (installHostDependencies) {
      await installHostDependencies({ layout, env, run });
    } else {
      const nodePath = join(layout.hermesHome, "node", "bin", "node");
      const npmCli = join(
        layout.hermesHome,
        "node", "lib", "node_modules", "npm", "bin", "npm-cli.js",
      );
      await Promise.all([
        access(nodePath, constants.X_OK),
        access(npmCli, constants.R_OK),
      ]);
      await run(nodePath, [npmCli, "ci", "--omit=dev", "--ignore-scripts"], {
        cwd: join(layout.profileDirectory, "host"),
        env,
        timeout: 10 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    for (const name of pluginDirectories) {
      await run(layout.profileAlias, [
        "plugins", "doctor", join(layout.profileDirectory, "plugins", name), "--ci",
      ], {
        cwd: layout.projectRoot,
        env,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    if (installGateway) {
      await run(layout.profileAlias, ["gateway", "install", "--no-start-now", "--start-on-login"], {
        cwd: layout.projectRoot,
        env,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  } catch (error) {
    await run(layout.hermesCommand, [
      "profile", "alias", "foursday", "--remove", "--name", "foursday-runtime",
    ], { cwd: layout.projectRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024 }).catch(() => {});
    await run(layout.hermesCommand, ["profile", "delete", "foursday", "--yes"], {
      cwd: layout.projectRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    }).catch(() => {});
    if (profileBackup) {
      await run(layout.hermesCommand, [
        "profile", "import", profileBackup.archive, "--name", "foursday",
      ], { cwd: layout.projectRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      await run(layout.hermesCommand, [
        "profile", "alias", "foursday", "--name", "foursday-runtime",
      ], { cwd: layout.projectRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
      await access(layout.profileAlias, constants.X_OK);
    }
    throw error;
  } finally {
    if (profileBackup) await rm(profileBackup.directory, { recursive: true, force: true });
  }
  return {
    installed: true,
    nativeHermesVerified: true,
    profileInstalled: true,
    pluginDoctorPassed: true,
    hostDependenciesInstalled: true,
    gatewayInstalled: Boolean(installGateway),
    gatewayStarted: false,
  };
}
