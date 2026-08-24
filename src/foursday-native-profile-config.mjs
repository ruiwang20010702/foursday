import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSecretReference, secretConfigKeys } from "./secret-provider.mjs";

const execFileAsync = promisify(execFile);
const memoryPromoterJobName = "foursday-memory-promoter";
const cronText = /^[^\u0000-\u001f\u007f]{1,20000}$/u;

async function privateJson(path, label) {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file`);
  }
  const value = JSON.parse(await readFile(absolute, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is invalid`);
  }
  return { absolute, value };
}

function absoluteExecutable(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function scalar(values, name, fallback = "") {
  const value = values[name];
  return value == null ? String(fallback) : String(value);
}

function envLine(name, value) {
  return `${name}=${JSON.stringify(String(value))}`;
}

export function foursdayCodexConfig({
  nodePath,
  mcpPath,
  projectRoots = [],
  pythonRuntimeRoot = null,
  pythonPath = null,
} = {}) {
  const node = absoluteExecutable(nodePath, "Codex MCP Node");
  const mcp = absoluteExecutable(mcpPath, "Foursday Codex MCP");
  return [
    'default_permissions = "foursday-workspace"',
    'approval_policy = "untrusted"',
    'approvals_reviewer = "auto_review"',
    "allow_login_shell = false",
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    "ignore_default_excludes = false",
    'exclude = ["FOURSDAY_*", "DWS_*", "DINGTALK_*", "HERMES_*", "*TOKEN*", "*SECRET*", "*KEY*", "*DATABASE*", "*PROXY*"]',
    ...(pythonPath ? [
      `set = { PYTHON = ${JSON.stringify(resolve(pythonPath))} }`,
    ] : []),
    "",
    "[tools]",
    "web_search = true",
    "view_image = true",
    "",
    "[features]",
    "multi_agent = true",
    "memories = true",
    "browser_use = false",
    "computer_use = false",
    "",
    "[permissions.foursday-workspace]",
    'description = "Foursday project workspace without host reads or command network"',
    'extends = ":workspace"',
    "",
    "[permissions.foursday-workspace.filesystem]",
    '":root" = "deny"',
    '":minimal" = "read"',
    ...(pythonRuntimeRoot ? [
      `${JSON.stringify(resolve(pythonRuntimeRoot))} = "read"`,
    ] : []),
    "glob_scan_max_depth = 6",
    "",
    "[permissions.foursday-workspace.filesystem.\":workspace_roots\"]",
    '"." = "write"',
    '".env" = "deny"',
    '".env.*" = "deny"',
    '".runtime" = "deny"',
    '"**/*.env" = "deny"',
    "",
    "[permissions.foursday-workspace.network]",
    "enabled = false",
    "",
    "[mcp_servers.foursday]",
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(mcp)}]`,
    'env_vars = ["FOURSDAY_PRODUCTION_CONFIG", "FOURSDAY_PROJECT_REGISTRY", "FOURSDAY_WORK_CONTEXT_FILE"]',
    "required = true",
    'enabled_tools = ["foursday_remember_project_fact", "foursday_list_attachments", "foursday_stage_attachment", "foursday_read_project_memory"]',
    'default_tools_approval_mode = "auto"',
    "",
    ...[...new Set(projectRoots)].flatMap((root) => [
      `[projects.${JSON.stringify(absoluteExecutable(root, "Foursday project root"))}]`,
      'trust_level = "untrusted"',
      "",
    ]),
  ].join("\n");
}

export function foursdayCodexRules() {
  const rawForbidden = [
    [["git", "push"], "Prepare a local commit and ask the owner to authorize push."],
    [["git", "add", "-A"], "Stage explicit reviewed files so temporary message inputs cannot enter Git."],
    [["git", "add", "--all"], "Stage explicit reviewed files so temporary message inputs cannot enter Git."],
    [["git", "add", "."], "Stage explicit reviewed files so temporary message inputs cannot enter Git."],
    [["git", "add", ".foursday-inbox"], "DWS attachment inbox files must never enter Git."],
    [["git", "reset", "--hard"], "Use a reversible branch or restore individual files."],
    [["git", "clean"], "List untracked files and ask the owner before removing them."],
    [["git", "restore"], "Preserve dirty worktree changes and restore only through an owner-authorized exit."],
    [["git", "checkout", "--"], "Preserve dirty worktree changes and restore only through an owner-authorized exit."],
    [["gh", "pr", "merge"], "Prepare the PR and ask the owner to authorize merge."],
    [["gh", "release"], "Prepare release notes and ask the owner to authorize publication."],
    [["npm", "publish"], "Build and verify the package without publishing it."],
    [["pnpm", "publish"], "Build and verify the package without publishing it."],
    [["yarn", "npm", "publish"], "Build and verify the package without publishing it."],
    [["kubectl"], "Prepare a deployment plan without touching a cluster."],
    [["helm"], "Render or validate locally without touching a cluster."],
    [["terraform", "apply"], "Generate and review a plan first."],
    [["terraform", "destroy"], "Destructive infrastructure changes require owner authorization."],
    [["tofu", "apply"], "Generate and review a plan first."],
    [["tofu", "destroy"], "Destructive infrastructure changes require owner authorization."],
    [["rm"], "Move scoped files to a recoverable location instead."],
    [["rmdir"], "Move scoped files to a recoverable location instead."],
    [["unlink"], "Move scoped files to a recoverable location instead."],
    [["shred"], "Irreversible deletion requires owner authorization."],
    [["sudo"], "System privilege escalation is outside the Foursday workspace."],
    [["launchctl"], "Service control requires an independent owner-authorized exit."],
    [["security"], "macOS Keychain access is reserved for host-side bridges."],
    [["osascript"], "GUI automation is not available to project commands."],
    [["diskutil"], "Disk administration is outside the Foursday workspace."],
    [["dd"], "Raw device or file destruction is prohibited."],
    [["shutdown"], "System power control is prohibited."],
    [["reboot"], "System power control is prohibited."],
    [["killall"], "System-wide process control is prohibited."],
    [["psql"], "Production database access requires an independent owner-authorized exit."],
    [["ssh"], "Direct remote execution is outside the project sandbox."],
    [["scp"], "Direct remote transfer is outside the project sandbox."],
  ];
  const commandForms = (command) => [
    command,
    `/usr/bin/${command}`,
    `/bin/${command}`,
    `/usr/sbin/${command}`,
    `/sbin/${command}`,
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
  ];
  const forbidden = rawForbidden.map(([pattern, justification]) => [
    [commandForms(pattern[0]), ...pattern.slice(1)],
    justification,
  ]);
  return `${forbidden.map(([pattern, justification]) =>
    `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="forbidden", justification=${JSON.stringify(justification)})`
  ).join("\n")}\n`;
}

async function atomicWrite(path, content, { replace = false } = {}) {
  const current = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077) !== 0) {
      throw new Error("Foursday native profile config destination is unsafe");
    }
    if (await readFile(path, "utf8") === content) return { changed: false, backup: null };
    if (!replace) {
      throw new Error(`Foursday native profile config already exists with different content: ${path}`);
    }
  }
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    let backup = null;
    if (current) {
      backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
      await copyFile(path, backup, constants.COPYFILE_EXCL);
      await chmod(backup, 0o600);
    }
    await rename(temporary, path);
    return { changed: true, backup };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function buildFoursdayNativeProfileConfiguration({
  layout,
  productionConfigPath,
  projectRegistryPath,
  nodePath,
  dwsPath,
  codexPath,
  pythonPath = null,
} = {}) {
  const production = await privateJson(productionConfigPath, "Foursday production config");
  const registry = await privateJson(projectRegistryPath, "Foursday project registry");
  if (registry.value.schemaVersion !== 1 || !Array.isArray(registry.value.projects)) {
    throw new Error("Foursday project registry is invalid");
  }
  for (const key of secretConfigKeys) {
    if (key in production.value && !isSecretReference(production.value[key])) {
      throw new Error(`Foursday production secret must remain externally referenced: ${key}`);
    }
  }
  const node = absoluteExecutable(nodePath, "Hermes managed Node");
  const dws = absoluteExecutable(dwsPath, "DWS executable");
  const codex = absoluteExecutable(codexPath, "Codex executable");
  const configuredPython = absoluteExecutable(
    pythonPath ?? join(layout.installDirectory, "venv", "bin", "python"),
    "Hermes managed Python",
  );
  await Promise.all([
    access(node, constants.X_OK),
    access(dws, constants.X_OK),
    access(codex, constants.X_OK),
    access(configuredPython, constants.X_OK),
  ]);
  const python = await realpath(configuredPython);
  const pythonRuntimeRoot = dirname(dirname(python));
  const localRoot = join(layout.profileDirectory, "local", "foursday");
  const stateRoot = join(localRoot, "state");
  const codexRoot = join(localRoot, "codex");
  const hostRoot = join(layout.profileDirectory, "host", "src");
  const targetConfig = join(localRoot, "production.json");
  const targetRegistry = join(localRoot, "projects.json");
  const codexProjectSkillSource = join(
    layout.projectRoot,
    "distribution", "skills", "project-work", "SKILL.md",
  );
  const environment = {
    FOURSDAY_NODE_PATH: node,
    FOURSDAY_DWS_SIDECAR: join(hostRoot, "hermes-dws-sidecar.mjs"),
    FOURSDAY_MEMORY_CONTEXT_SIDECAR: join(hostRoot, "hermes-personal-memory-context.mjs"),
    FOURSDAY_MEMORY_CANDIDATE_SIDECAR: join(hostRoot, "hermes-memory-candidate-sidecar.mjs"),
    FOURSDAY_PRODUCTION_CONFIG: targetConfig,
    FOURSDAY_PROJECT_REGISTRY: targetRegistry,
    FOURSDAY_FALLBACK_WORKSPACE: join(localRoot, "fallback"),
    FOURSDAY_ROUTE_STATE_FILE: join(stateRoot, "routes.json"),
    FOURSDAY_SHADOW_EVIDENCE_FILE: join(stateRoot, "shadow-evidence.jsonl"),
    FOURSDAY_WORK_CONTEXT_FILE: join(stateRoot, "work-contexts.json"),
    FOURSDAY_THREAD_BINDINGS_ROOT: join(stateRoot, "thread-bindings"),
    FOURSDAY_CONTROL_FILE: join(stateRoot, "control.json"),
    FOURSDAY_MODE: "shadow",
    FOURSDAY_MEMORY_HOME: layout.userHome,
    FOURSDAY_DWS_HOME: layout.userHome,
    FOURSDAY_CODEX_PATH: codex,
    FOURSDAY_PYTHON_PATH: python,
    FOURSDAY_PROFILE_INSTRUCTIONS_FILE: join(layout.profileDirectory, "SOUL.md"),
    FOURSDAY_PROJECT_SKILL_FILE: join(layout.profileDirectory, "skills", "project-work", "SKILL.md"),
    FOURSDAY_REQUIRE_WORK_CONTEXT: "true",
    CODEX_HOME: codexRoot,
    DWS_PATH: dws,
    DWS_PERSONAL_ALLOWED_USERS: scalar(production.value, "FOURSDAY_DINGTALK_USERS"),
    DWS_PERSONAL_FETCH_USERS: scalar(production.value, "FOURSDAY_DINGTALK_USERS"),
    DWS_PERSONAL_ALLOWED_GROUPS: scalar(production.value, "FOURSDAY_DINGTALK_GROUPS"),
    DINGTALK_SELF_USER_ID: scalar(production.value, "FOURSDAY_DINGTALK_SELF_USER"),
    DINGTALK_DATA_ROOT: join(layout.userHome, "Library", "Application Support", "DingTalkMac"),
    DWS_PERSONAL_STATE_FILE: join(stateRoot, "dws.json"),
    DWS_PERSONAL_MEDIA_ROOT: join(stateRoot, "media"),
    // A bounded overlap keeps restarts lossless without replaying old conversations.
    DWS_PERSONAL_INITIAL_LOOKBACK_MS: "600000",
    DWS_PERSONAL_FALLBACK_MS: scalar(production.value, "FOURSDAY_DINGTALK_FALLBACK_MS", 30_000),
    DWS_PERSONAL_BUNDLE_QUIET_MS: scalar(production.value, "FOURSDAY_DINGTALK_QUIET_MS", 3_000),
    DWS_PERSONAL_BUNDLE_MAX_WAIT_MS: scalar(production.value, "FOURSDAY_DINGTALK_MAX_WAIT_MS", 8_000),
    DWS_PERSONAL_EVENT_WAKE_ENABLED: scalar(
      production.value, "FOURSDAY_DINGTALK_EVENT_WAKE_ENABLED", true,
    ),
    DWS_PERSONAL_OUTBOUND_QUIET_MS: scalar(
      production.value, "FOURSDAY_DINGTALK_OUTBOUND_QUIET_MS", 8_000,
    ),
    DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS: scalar(
      production.value, "FOURSDAY_DINGTALK_OUTBOUND_MAX_QUIET_MS", 20_000,
    ),
    DWS_PERSONAL_SEND_ENABLED: "false",
    PATH: [join(layout.profileDirectory, "host", "bin"), dirname(codex), dirname(node),
      "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  };
  return {
    schema: "foursday-native-profile-config/v1",
    localRoot,
    stateRoot,
    codexRoot,
    targetConfig,
    targetRegistry,
    codexProjectSkillSource,
    sourceConfig: production.absolute,
    sourceRegistry: registry.absolute,
    environment,
    envContent: `${Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => envLine(name, value))
      .join("\n")}\n`,
    secretsCopied: false,
    codexConfigContent: foursdayCodexConfig({
      nodePath: node,
      mcpPath: join(hostRoot, "foursday-codex-mcp.mjs"),
      projectRoots: [
        ...registry.value.projects.map((project) => project.root),
        join(localRoot, "fallback"),
      ],
      pythonRuntimeRoot,
      pythonPath: python,
    }),
    codexRulesContent: foursdayCodexRules(),
    sendEnabled: false,
    mode: "shadow",
  };
}

export async function configureFoursdayNativeProfile(options = {}) {
  const plan = await buildFoursdayNativeProfileConfiguration(options);
  if (!options.apply) return { ...plan, apply: false, changed: false };
  await Promise.all([
    mkdir(plan.localRoot, { recursive: true, mode: 0o700 }),
    mkdir(plan.stateRoot, { recursive: true, mode: 0o700 }),
    mkdir(plan.environment.FOURSDAY_FALLBACK_WORKSPACE, { recursive: true, mode: 0o700 }),
    mkdir(join(plan.codexRoot, "rules"), { recursive: true, mode: 0o700 }),
    mkdir(join(plan.codexRoot, "skills", "project-work"), { recursive: true, mode: 0o700 }),
    mkdir(join(plan.codexRoot, "memories"), { recursive: true, mode: 0o700 }),
    mkdir(plan.environment.FOURSDAY_THREAD_BINDINGS_ROOT, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(plan.localRoot, 0o700),
    chmod(plan.stateRoot, 0o700),
    chmod(plan.environment.FOURSDAY_FALLBACK_WORKSPACE, 0o700),
    chmod(plan.codexRoot, 0o700),
    chmod(join(plan.codexRoot, "rules"), 0o700),
    chmod(join(plan.codexRoot, "skills"), 0o700),
    chmod(join(plan.codexRoot, "skills", "project-work"), 0o700),
    chmod(join(plan.codexRoot, "memories"), 0o700),
    chmod(plan.environment.FOURSDAY_THREAD_BINDINGS_ROOT, 0o700),
  ]);
  const codexSkillContent = await readFile(plan.codexProjectSkillSource, "utf8");
  const [
    configResult,
    registryResult,
    envResult,
    codexConfigResult,
    codexRulesResult,
    codexSkillResult,
  ] = await Promise.all([
    atomicWrite(
      plan.targetConfig,
      `${JSON.stringify(JSON.parse(await readFile(plan.sourceConfig, "utf8")), null, 2)}\n`,
      { replace: options.replace },
    ),
    atomicWrite(
      plan.targetRegistry,
      `${JSON.stringify(JSON.parse(await readFile(plan.sourceRegistry, "utf8")), null, 2)}\n`,
      { replace: options.replace },
    ),
    atomicWrite(join(options.layout.profileDirectory, ".env"), plan.envContent, {
      replace: options.replace,
    }),
    atomicWrite(join(plan.codexRoot, "config.toml"), plan.codexConfigContent, {
      replace: options.replace,
    }),
    atomicWrite(join(plan.codexRoot, "rules", "foursday.rules"), plan.codexRulesContent, {
      replace: options.replace,
    }),
    atomicWrite(
      join(plan.codexRoot, "skills", "project-work", "SKILL.md"),
      codexSkillContent,
      { replace: options.replace },
    ),
  ]);
  return {
    ...plan,
    apply: true,
    changed: configResult.changed || registryResult.changed || envResult.changed ||
      codexConfigResult.changed || codexRulesResult.changed || codexSkillResult.changed,
    backupsCreated: [configResult.backup, registryResult.backup, envResult.backup,
      codexConfigResult.backup, codexRulesResult.backup, codexSkillResult.backup]
      .filter(Boolean).length,
  };
}

function memoryPromoterJobMatches(job) {
  return Boolean(
    job?.name === memoryPromoterJobName &&
    job?.script === "foursday-memory-promoter.sh" &&
    job?.no_agent === true &&
    job?.enabled !== false &&
    job?.schedule?.kind === "interval" &&
    (Number(job?.schedule?.seconds) === 60 || Number(job?.schedule?.minutes) === 1)
  );
}

function cronJobs(document) {
  if (Array.isArray(document)) return document;
  if (
    document &&
    !Array.isArray(document) &&
    typeof document === "object" &&
    Array.isArray(document.jobs)
  ) return document.jobs;
  throw new Error("Hermes cron store is invalid");
}

export async function ensureFoursdayMemoryPromoterCron({
  layout,
  apply = false,
  run = execFileAsync,
} = {}) {
  const jobsPath = join(layout.profileDirectory, "cron", "jobs.json");
  const document = await readFile(jobsPath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const existing = cronJobs(document);
  if (existing.length > 1_000) {
    throw new Error("Hermes cron store is invalid");
  }
  const owned = existing.filter((job) => job?.name === memoryPromoterJobName);
  if (owned.length > 1 || (owned[0] && !memoryPromoterJobMatches(owned[0]))) {
    throw new Error("Foursday memory promoter cron conflicts with an existing job");
  }
  if (owned.length === 1) {
    return { apply, created: false, verified: true, jobId: owned[0].id ?? null };
  }
  if (!apply) return { apply: false, created: false, verified: false, jobId: null };
  await run(layout.profileAlias, [
    "cron", "create", "every 1m",
    "--no-agent",
    "--script", "foursday-memory-promoter.sh",
    "--name", memoryPromoterJobName,
  ], {
    cwd: layout.profileDirectory,
    env: {
      HOME: layout.userHome,
      HERMES_HOME: layout.profileDirectory,
      PATH: `${join(layout.userHome, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NO_COLOR: "1",
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const readBack = cronJobs(JSON.parse(await readFile(jobsPath, "utf8")));
  const created = readBack.filter((job) => job?.name === memoryPromoterJobName);
  if (created.length !== 1 || !memoryPromoterJobMatches(created[0])) {
    throw new Error("Foursday memory promoter cron read-back failed");
  }
  return { apply: true, created: true, verified: true, jobId: created[0].id ?? null };
}

function codexCronJobMatches(job, { name, prompt, project, monitorScript = null }) {
  return Boolean(
    job?.name === name &&
    job?.enabled !== false &&
    job?.no_agent !== true &&
    job?.workdir === project.root &&
    job?.prompt === `${prompt}\n\n<!-- foursday-schedule:${project.id} -->` &&
    job?.deliver === "local" &&
    Array.isArray(job?.context_from) && job.context_from.includes("self") &&
    (job?.monitor_script ?? null) === monitorScript
  );
}

export async function ensureFoursdayCodexCron({
  layout,
  project,
  schedule,
  prompt,
  name,
  monitorScript = null,
  apply = false,
  run = execFileAsync,
} = {}) {
  if (
    !project || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(String(project.id ?? "")) ||
    !isAbsolute(project.root) || resolve(project.root) !== project.root
  ) throw new Error("Foursday Codex cron project is invalid");
  for (const [label, value, maximum] of [
    ["schedule", schedule, 200],
    ["prompt", prompt, 20_000],
    ["name", name, 200],
  ]) {
    if (!cronText.test(String(value ?? "")) || String(value).length > maximum) {
      throw new Error(`Foursday Codex cron ${label} is invalid`);
    }
  }
  if (/<!--\s*foursday-(?:context|schedule):/iu.test(String(prompt))) {
    throw new Error("Foursday Codex cron prompt contains a reserved marker");
  }
  if (
    monitorScript != null &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(String(monitorScript))
  ) throw new Error("Foursday Codex cron monitor script is invalid");
  const jobsPath = join(layout.profileDirectory, "cron", "jobs.json");
  const document = await readFile(jobsPath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const jobs = cronJobs(document);
  if (jobs.length > 1_000) throw new Error("Hermes cron store is invalid");
  const owned = jobs.filter((job) => job?.name === name);
  if (owned.length > 1 || (owned[0] && !codexCronJobMatches(
    owned[0], { name, prompt, project, monitorScript },
  ))) {
    throw new Error("Foursday Codex cron conflicts with an existing job");
  }
  if (owned.length === 1) {
    return { apply, created: false, verified: true, jobId: owned[0].id ?? null };
  }
  if (!apply) return { apply: false, created: false, verified: false, jobId: null };
  const scheduledPrompt = `${prompt}\n\n<!-- foursday-schedule:${project.id} -->`;
  const args = [
    "cron", "create", String(schedule), scheduledPrompt,
    "--workdir", project.root,
    "--deliver", "local",
    "--continuity",
    "--name", String(name),
    ...(monitorScript ? ["--monitor-script", String(monitorScript)] : []),
  ];
  await run(layout.profileAlias, args, {
    cwd: layout.profileDirectory,
    env: {
      HOME: layout.userHome,
      HERMES_HOME: layout.profileDirectory,
      PATH: `${join(layout.userHome, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NO_COLOR: "1",
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const readBack = cronJobs(JSON.parse(await readFile(jobsPath, "utf8")));
  const created = readBack.filter((job) => job?.name === name);
  if (created.length !== 1 || !codexCronJobMatches(
    created[0], { name, prompt, project, monitorScript },
  )) {
    throw new Error("Foursday Codex cron read-back failed");
  }
  return { apply: true, created: true, verified: true, jobId: created[0].id ?? null };
}
