import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { discoverFoursdayProjectRegistry } from "./foursday-project-discovery.mjs";

const execFileAsync = promisify(execFile);
const setupSteps = Object.freeze([
  "prerequisites", "account", "projects", "runtime", "profile", "codex", "shadow", "verification",
]);
const setupStepLabels = Object.freeze({
  runtime: "安装 Foursday",
  profile: "连接项目与记忆",
  codex: "连接 Codex 工作环境",
  shadow: "启动试用",
  verification: "执行只读验证",
});

function userError(code, message, action) {
  const error = new Error(message);
  error.code = code;
  error.recommendedAction = action;
  return error;
}

async function privateJson(path, { optional = false, maximum = 8 * 1024 * 1024 } = {}) {
  if (!path || !isAbsolute(path)) throw userError("unsafe_input", "配置路径无效", "在 Codex 中重新选择文件");
  const handle = await open(resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximum ||
      await realpath(resolve(path)) !== resolve(path) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw userError("unsafe_input", "配置文件不安全", "在 Codex 中修复文件权限");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function privateWrite(path, value) {
  const destination = resolve(path);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o077) !== 0 ||
    await realpath(parent) !== parent ||
    (typeof process.getuid === "function" && parentMetadata.uid !== process.getuid())
  ) throw userError("unsafe_output", "安装恢复目录不安全", "在 Codex 中修复目录权限");
  await chmod(parent, 0o700);
  const existing = await lstat(destination).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (
    existing?.isSymbolicLink() || (existing && !existing.isFile()) ||
    (existing && (existing.mode & 0o077) !== 0) ||
    (existing && typeof process.getuid === "function" && existing.uid !== process.getuid())
  ) throw userError("unsafe_output", "安装恢复文件不安全", "在 Codex 中修复文件权限");
  const temporary = join(parent, `.foursday-setup-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function executable(name, environment = process.env) {
  const paths = String(environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  for (const path of paths) {
    const candidate = join(path, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  return null;
}

async function commandJson(path, args, { environment = process.env, timeout = 30_000 } = {}) {
  const result = await execFileAsync(path, args, {
    env: environment,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(String(result.stdout ?? "").trim() || "null");
}

export async function inspectFoursdaySetupEnvironment({
  environment = process.env,
  userHome = homedir(),
} = {}) {
  const [codexPath, dwsPath, gitPath] = await Promise.all([
    executable("codex", environment), executable("dws", environment), executable("git", environment),
  ]);
  const nodeReady = Number(process.versions.node.split(".")[0]) >= 22;
  let dwsProfiles = [];
  let currentDwsProfile = null;
  if (dwsPath) {
    try {
      const document = await commandJson(dwsPath, ["profile", "list", "--format", "json"], { environment });
      dwsProfiles = Array.isArray(document?.profiles) ? document.profiles.slice(0, 50).map((item) => ({
        profile: String(item?.profile ?? "").slice(0, 300),
        label: [item?.corpName, item?.userName].filter(Boolean).join(" · ").slice(0, 160) || "已登录钉钉账号",
        current: item?.isCurrent === true,
        status: String(item?.status ?? "unknown").slice(0, 40),
      })).filter((item) => item.profile) : [];
      currentDwsProfile = dwsProfiles.find((item) => item.current)?.profile ?? null;
    } catch {}
  }
  let codexAuthenticated = false;
  if (codexPath) {
    try {
      await execFileAsync(codexPath, ["login", "status"], {
        env: environment, timeout: 15_000, maxBuffer: 256 * 1024,
      });
      codexAuthenticated = true;
    } catch {}
  }
  const codexCatalog = await readCodexProjectCatalog({ userHome }).catch(() => ({
    schemaVersion: 2, projects: [],
  }));
  return {
    nodeReady,
    gitPath,
    codexPath,
    dwsPath,
    codexAuthenticated,
    dwsProfiles,
    currentDwsProfile,
    codexCatalog,
  };
}

export async function resolveFoursdaySetupSelections(detected, {
  account = null,
  roots = [],
  askOne = async () => null,
  askMany = async () => [],
} = {}) {
  let selectedAccount = account ?? detected.currentDwsProfile ?? (
    detected.dwsProfiles.length === 1 ? detected.dwsProfiles[0].profile : null
  );
  let selectedRoots = roots.length > 0 ? roots : (
    detected.codexCatalog.projects.length === 1 ? [detected.codexCatalog.projects[0].path] : []
  );
  let questionsAsked = 0;
  if (!selectedAccount && detected.dwsProfiles.length > 0) {
    questionsAsked += 1;
    const index = await askOne({
      prompt: "选择用于工作的钉钉账号",
      options: detected.dwsProfiles.map((item) => item.label),
    });
    if (Number.isSafeInteger(index) && detected.dwsProfiles[index]) {
      selectedAccount = detected.dwsProfiles[index].profile;
    }
  }
  if (selectedRoots.length === 0 && detected.codexCatalog.projects.length > 0) {
    questionsAsked += 1;
    const indexes = await askMany({
      prompt: "选择允许 Foursday 工作的项目目录",
      options: detected.codexCatalog.projects.map((item) => item.label),
    });
    selectedRoots = [...new Set(indexes)]
      .filter((index) => Number.isSafeInteger(index) && detected.codexCatalog.projects[index])
      .map((index) => detected.codexCatalog.projects[index].path);
  }
  return { account: selectedAccount, roots: selectedRoots, questionsAsked };
}

export async function readCodexProjectCatalog({ userHome = homedir() } = {}) {
  const statePath = join(userHome, ".codex", ".codex-global-state.json");
  const document = await privateJson(statePath);
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
          isGitRepository: await lstat(join(path, ".git")).then((item) => item.isDirectory()).catch(() => false),
        });
      }
    }
  }
  return { schemaVersion: 2, projects };
}

function selectedProjects(catalog, roots) {
  const selected = new Set(roots.map((path) => resolve(path)));
  const output = catalog.projects.filter((project) => selected.has(resolve(project.path)));
  for (const root of selected) {
    if (!output.some((project) => resolve(project.path) === root)) {
      output.push({
        projectId: `manual-${output.length + 1}`,
        projectKind: "local",
        label: basename(root),
        path: root,
        hostId: "local",
        hostDisplayName: null,
        isGitRepository: false,
      });
    }
  }
  return { schemaVersion: 2, projects: output };
}

function completedState(document) {
  const completed = Array.isArray(document?.completed) ? document.completed : [];
  return new Set(completed.filter((step) => setupSteps.includes(step)));
}

function setupSelectionHash({ account, roots, configPath, releaseIdentity }) {
  return createHash("sha256").update(JSON.stringify({
    account: String(account ?? ""),
    roots: roots.map((path) => resolve(path)).sort(),
    configPath: resolve(configPath),
    releaseIdentity: String(releaseIdentity ?? "development"),
  })).digest("hex");
}

function publicStep(step, state, detail) {
  return { step, state, detail: String(detail ?? "").slice(0, 200) };
}

export async function runFoursdaySetup({
  apply = false,
  configPath,
  account = null,
  roots = [],
  environment = process.env,
  userHome = homedir(),
  setupRoot = join(userHome, ".foursday"),
  releaseIdentity = "development",
  inspect = inspectFoursdaySetupEnvironment,
  listMemoryProjects = async () => [],
  install = async () => ({ installed: false }),
  configure = async () => ({ profileConfigured: false }),
  login = async () => ({ authenticated: false }),
  gateway = async () => ({ ready: false }),
  verify = async () => ({ verified: false }),
} = {}) {
  if (!isAbsolute(setupRoot)) throw userError("unsafe_output", "安装恢复目录无效", "在 Codex 中重新选择目录");
  if (!configPath || !isAbsolute(configPath)) {
    throw userError("unsafe_input", "配置路径无效", "在 Codex／Claude 插件中重新连接工作数据");
  }
  const statePath = join(setupRoot, "setup-state.json");
  const registryPath = join(setupRoot, "projects.json");
  const prior = await privateJson(statePath, { optional: true });
  let completed = new Set();
  const detected = await inspect({ environment, userHome });
  const steps = [];
  const missingTools = [
    !detected.nodeReady && "Node 22+",
    !detected.gitPath && "Git",
    !detected.codexPath && "Codex",
    !detected.dwsPath && "DWS",
  ].filter(Boolean);
  if (missingTools.length > 0) {
    return {
      schema: "foursday-setup/v1", state: "needs_action", ready: false, apply,
      title: "安装工具尚未齐全",
      detail: `缺少：${missingTools.join("、")}`,
      recommendedAction: "在 Codex 中安装缺少的工具后重试",
      questionsAsked: 0,
      steps: [publicStep("环境检测", "needs_action", "缺少安装工具")],
    };
  }
  steps.push(publicStep("环境检测", "ready", "Node、Git、Codex 和 DWS 已就绪"));

  const chosenAccount = account ?? detected.currentDwsProfile ?? (
    detected.dwsProfiles.length === 1 ? detected.dwsProfiles[0].profile : null
  );
  const availableRoots = detected.codexCatalog.projects.map((item) => item.path);
  const chosenRoots = roots.length > 0 ? roots : availableRoots.length === 1 ? availableRoots : [];
  const questions = [];
  if (!chosenAccount) questions.push({
    id: "dingtalk_account", prompt: "选择用于工作的钉钉账号", options: detected.dwsProfiles.map((item) => item.label),
  });
  if (chosenRoots.length === 0) questions.push({
    id: "project_roots", prompt: "选择允许 Foursday 工作的项目目录", options: availableRoots.map((path) => basename(path)),
  });
  if (questions.length > 0) {
    return {
      schema: "foursday-setup/v1", state: "needs_input", ready: false, apply,
      title: "还需要完成少量选择",
      detail: "Foursday 只询问无法可靠推断的信息",
      recommendedAction: "在 Codex／Claude 插件中完成选择",
      questionsAsked: questions.length,
      questions: questions.slice(0, 3),
      accountCount: detected.dwsProfiles.length,
      discoverableProjectCount: availableRoots.length,
      steps,
    };
  }
  if (chosenRoots.some((path) => !isAbsolute(path))) {
    throw userError("unsafe_input", "项目目录必须使用绝对路径", "在 Codex 中重新选择项目目录");
  }
  const selectionHash = setupSelectionHash({
    account: chosenAccount, roots: chosenRoots, configPath, releaseIdentity,
  });
  completed = prior?.selectionHash === selectionHash ? completedState(prior) : new Set();
  completed.add("prerequisites");
  completed.add("account");
  completed.add("projects");
  steps.push(publicStep("钉钉账号", "ready", "已选择登录账号"));
  steps.push(publicStep("项目目录", "ready", `已选择 ${chosenRoots.length} 个项目根目录`));

  const selectedCatalog = selectedProjects(detected.codexCatalog, chosenRoots);
  let gbrainProjects = [];
  try { gbrainProjects = await listMemoryProjects({ configPath }); } catch {}
  const discovered = await discoverFoursdayProjectRegistry({
    catalog: selectedCatalog,
    existingRegistry: { schemaVersion: 2, workspaces: [], scopes: [] },
    gbrainProjects,
    userHome,
  });
  const config = await privateJson(configPath, { optional: true });
  if (!config) {
    return {
      schema: "foursday-setup/v1", state: "needs_action", ready: false, apply,
      title: "需要连接工作数据",
      detail: "项目目录已经识别，但数据库与个人记忆连接尚未配置",
      recommendedAction: "在 Codex／Claude 插件中连接 PostgreSQL 与个人 gbrain",
      questionsAsked: 0,
      selectedProjectCount: discovered.summary.includedProjects,
      steps,
    };
  }
  if (!apply) {
    return {
      schema: "foursday-setup/v1", state: "preview", ready: false, apply: false,
      title: "可以开始试用安装",
      detail: "确认后将安装并启动发送关闭的试用模式",
      recommendedAction: "运行 foursday setup --apply",
      questionsAsked: 0,
      selectedProjectCount: discovered.summary.includedProjects,
      memoryStatus: gbrainProjects.length > 0 ? "已连接个人记忆" : "暂未读取到个人记忆，可先继续试用",
      steps: [...steps, ...setupSteps.slice(3).map((step) => publicStep(setupStepLabels[step], "planned", "等待确认"))],
    };
  }

  await privateWrite(registryPath, discovered.registry);
  const persist = async (step) => {
    completed.add(step);
    await privateWrite(statePath, {
      schema: "foursday-setup-state/v1",
      selectionHash,
      completed: setupSteps.filter((item) => completed.has(item)),
      selectedProjectCount: discovered.summary.includedProjects,
      updatedAt: new Date().toISOString(),
    });
  };
  if (!completed.has("runtime")) {
    await install({ apply: true });
    await persist("runtime");
  }
  steps.push(publicStep("安装 Foursday", "ready", "运行组件已安装"));
  if (!completed.has("profile")) {
    await configure({ apply: true, configPath, registryPath });
    await persist("profile");
  }
  steps.push(publicStep("连接项目与记忆", "ready", "Profile 已配置"));
  if (!completed.has("codex")) {
    await login({ apply: true, configPath });
    await persist("codex");
  }
  steps.push(publicStep("Codex 认证", "ready", "工作环境已认证"));
  if (!completed.has("shadow")) {
    await gateway("install-shadow", { apply: true });
    await gateway("start-shadow", { apply: true });
    await persist("shadow");
  }
  steps.push(publicStep("启动试用", "ready", "试用中，不会自动回复"));
  if (!completed.has("verification")) {
    const result = await verify({ apply: true, configPath });
    if (result?.verified === false || result?.success === false) {
      throw userError("verification_failed", "真实 Codex 只读验证未通过", "查看失败摘要并让 AI 继续修复");
    }
    await persist("verification");
  }
  steps.push(publicStep("试用验证", "ready", "真实 Codex 只读验证通过"));
  return {
    schema: "foursday-setup/v1", state: "trial_ready", ready: true, apply: true,
    title: "试用已就绪",
    detail: "Foursday 已启动，但不会自动回复钉钉消息",
    recommendedAction: "先在本人会话完成一项只读试用任务",
    questionsAsked: 0,
    selectedProjectCount: discovered.summary.includedProjects,
    memoryStatus: gbrainProjects.length > 0 ? "已连接个人记忆" : "暂未读取到个人记忆，可先继续试用",
    messagesSent: 0,
    productionWrite: false,
    steps,
  };
}
