import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { inspectFoursdayNativeGateway } from "./foursday-native-gateway.mjs";
import { FoursdayControlStore } from "./foursday-control-store.mjs";
import { legacyProjectsFromWorkScopes } from "./foursday-work-scope-registry.mjs";

const digest = /^[a-f0-9]{64}$/u;

async function privateJson(path, { optional = false, maximum = 1024 * 1024 } = {}) {
  if (!isAbsolute(path)) throw new Error("Foursday control source path must be absolute");
  const absolute = resolve(path);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximum ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new Error("Foursday control source file is unsafe");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function projectRegistry(path) {
  const document = await privateJson(path);
  return legacyProjectsFromWorkScopes(document).map((project) => ({
    id: String(project.id ?? "").slice(0, 64),
    name: String(project.name ?? "").slice(0, 200),
    root: String(project.root ?? ""),
    parentId: project.parentId ?? null,
    workspaceId: project.workspaceId ?? project.id,
    gbrainSlugs: Array.isArray(project.gbrainSlugs)
      ? project.gbrainSlugs.slice(0, 20).map((value) => String(value).slice(0, 300))
      : [],
  }));
}

async function threadBindings(root) {
  if (!isAbsolute(root)) throw new Error("Foursday thread binding root must be absolute");
  const absolute = resolve(root);
  const metadata = await lstat(absolute).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!metadata) return [];
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("Foursday thread binding root is unsafe");
  }
  const output = [];
  for (const name of (await readdir(absolute)).sort()) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const document = await privateJson(join(absolute, name), { maximum: 64 * 1024 });
    if (
      document?.schema !== "foursday-thread-binding/v1" ||
      !digest.test(String(document.scope?.sourceSessionHash ?? ""))
    ) continue;
    output.push({
      taskId: document.scope.sourceSessionHash,
      projectId: String(document.scope.projectId ?? "").slice(0, 64),
      codexThreadId: String(document.codexThreadId ?? "").slice(0, 500),
      forkCount: Array.isArray(document.forkThreadIds) ? document.forkThreadIds.length : 0,
      ownerRevision: Number(document.ownerRevision ?? 0),
      sendGeneration: Number(document.sendGeneration ?? 0),
      updatedAt: document.updatedAt ?? null,
    });
  }
  return output;
}

function normalizedSchedule(job, projectByRoot) {
  const rawDelivery = String(job?.deliver ?? "local");
  const delivery = rawDelivery === "local" || rawDelivery === "origin"
    ? rawDelivery
    : [...new Set(rawDelivery.split(",").map((value) => value.trim().split(":")[0]).filter(Boolean))]
        .map((value) => `${value}:configured`).join(",");
  return {
    id: String(job?.id ?? "").slice(0, 100),
    name: String(job?.name ?? "").slice(0, 200),
    projectId: projectByRoot.get(String(job?.workdir ?? "")) ?? null,
    enabled: job?.enabled !== false,
    state: String(job?.state ?? "unknown").slice(0, 40),
    schedule: String(job?.schedule_display ?? job?.schedule?.display ?? "").slice(0, 200),
    nextRunAt: job?.next_run_at ?? null,
    lastRunAt: job?.last_run_at ?? null,
    lastStatus: job?.last_status == null ? null : String(job.last_status).slice(0, 80),
    monitor: Boolean(job?.monitor_script || job?.monitor_url),
    continuity: Array.isArray(job?.context_from) && job.context_from.includes("self"),
    delivery: delivery.slice(0, 80),
  };
}

async function evidenceSummary(path) {
  if (!path || !isAbsolute(path)) return { count: 0, byType: {}, lastEventAt: null };
  const metadata = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!metadata) return { count: 0, byType: {}, lastEventAt: null };
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
    metadata.size > 16 * 1024 * 1024 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("Foursday evidence file is unsafe");
  }
  const rows = (await readFile(path, "utf8")).split("\n").filter(Boolean).slice(-10_000);
  const byType = {};
  let lastEventAt = null;
  for (const row of rows) {
    let event;
    try { event = JSON.parse(row); } catch { continue; }
    const type = String(event?.type ?? "unknown").replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80);
    byType[type] = (byType[type] ?? 0) + 1;
    const occurredAt = event?.occurredAt;
    if (typeof occurredAt === "string" && (!lastEventAt || occurredAt > lastEventAt)) lastEventAt = occurredAt;
  }
  return { count: Object.values(byType).reduce((sum, value) => sum + value, 0), byType, lastEventAt };
}

export class FoursdayControlService {
  constructor({
    layout,
    controlPath,
    registryPath,
    threadBindingRoot,
    evidencePath,
    productionConfigPath,
    gatewayInspector = inspectFoursdayNativeGateway,
  }) {
    this.layout = layout;
    this.controlPath = controlPath;
    this.registryPath = registryPath;
    this.threadBindingRoot = threadBindingRoot;
    this.evidencePath = evidencePath;
    this.productionConfigPath = productionConfigPath;
    this.gatewayInspector = gatewayInspector;
    this.store = new FoursdayControlStore({ path: controlPath });
  }

  async status() {
    const [gateway, control] = await Promise.all([
      this.gatewayInspector({ layout: this.layout }),
      this.store.snapshot(),
    ]);
    const tasks = await this.tasks(control);
    return {
      schema: "foursday-control-status/v1",
      ready: gateway.ready === true && control.global.state === "running",
      gateway: {
        installed: gateway.installed === true,
        mode: gateway.mode,
        accessPolicy: gateway.accessPolicy ?? "explicit_users",
        enterpriseUsersEnabled: gateway.enterpriseUsersEnabled === true,
        sendEnabled: gateway.sendEnabled === true,
        sendBlocked: gateway.sendBlocked === true,
        running: gateway.running === true,
        checkpointHealthy: gateway.checkpointHealthy === true,
        checkpointState: gateway.checkpointState ?? "stale",
        checkpointBusy: gateway.checkpointBusy === true,
        checkpointGeneration: Number.isSafeInteger(gateway.checkpointGeneration)
          ? gateway.checkpointGeneration
          : 0,
        checkpointOperation: gateway.checkpointOperation ?? null,
        manualReplyProbeReady: typeof gateway.manualReplyProbeReady === "boolean"
          ? gateway.manualReplyProbeReady
          : null,
        manualReplyProbeDegraded: gateway.manualReplyProbeDegraded === true,
        manualReplyProbeErrorCode: gateway.manualReplyProbeErrorCode ?? null,
        deferredReplyWaiting: gateway.deferredReplyWaiting === true,
        deferredReplyAttemptCount: Number.isSafeInteger(gateway.deferredReplyAttemptCount)
          ? gateway.deferredReplyAttemptCount
          : 0,
        deferredReplyErrorCode: gateway.deferredReplyErrorCode ?? null,
        deferredReplyExpiresAt: gateway.deferredReplyExpiresAt ?? null,
        enterpriseIdentityRetryPending:
          Number.isSafeInteger(gateway.enterpriseIdentityRetryPending) &&
            gateway.enterpriseIdentityRetryPending >= 0
            ? gateway.enterpriseIdentityRetryPending
            : 0,
        enterpriseIdentityRejectionCount:
          Number.isSafeInteger(gateway.enterpriseIdentityRejectionCount) &&
            gateway.enterpriseIdentityRejectionCount >= 0
            ? gateway.enterpriseIdentityRejectionCount
            : 0,
        enterpriseIdentityLastErrorCode: gateway.enterpriseIdentityLastErrorCode ?? null,
        modeConsistent: gateway.modeConsistent === true,
        eventWakeEnabled: gateway.eventWakeEnabled === true,
        eventWakeReady: gateway.eventWakeReady === true,
        eventWakeDegraded: gateway.eventWakeDegraded === true,
        lastWakeSource: gateway.lastWakeSource ?? null,
        lastDetectionLatencyMs: Number.isFinite(gateway.lastDetectionLatencyMs)
          ? gateway.lastDetectionLatencyMs
          : null,
      },
      control: { revision: control.revision, state: control.global.state },
      taskCounts: tasks.items.reduce((counts, item) => {
        counts[item.state] = (counts[item.state] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }

  async tasks(controlSnapshot = null) {
    const [control, bindings] = await Promise.all([
      controlSnapshot ? Promise.resolve(controlSnapshot) : this.store.snapshot(),
      threadBindings(this.threadBindingRoot),
    ]);
    const bindingByTask = new Map(bindings.map((item) => [item.taskId, item]));
    const ids = new Set([...Object.keys(control.tasks), ...bindingByTask.keys()]);
    const items = [...ids].sort().map((taskId) => {
      const task = control.tasks[taskId];
      const binding = bindingByTask.get(taskId);
      return {
        taskId,
        projectId: task?.projectId ?? binding?.projectId ?? null,
        state: task?.state ?? "active",
        ownerRevision: Math.max(task?.ownerRevision ?? 0, binding?.ownerRevision ?? 0),
        sendGeneration: Math.max(task?.sendGeneration ?? 0, binding?.sendGeneration ?? 0),
        codexThreadId: binding?.codexThreadId ?? null,
        forkCount: binding?.forkCount ?? 0,
        lastInboundAt: task?.lastInboundAt ?? null,
        updatedAt: task?.updatedAt ?? binding?.updatedAt ?? null,
        pendingIntervention: task?.pendingEvent && !task.pendingEvent.consumed
          ? { type: task.pendingEvent.type, createdAt: task.pendingEvent.createdAt }
          : null,
      };
    });
    return { schema: "foursday-control-tasks/v1", revision: control.revision, items };
  }

  async schedules() {
    const projects = await projectRegistry(this.registryPath);
    const projectByRoot = new Map(projects.map((project) => [project.root, project.id]));
    const path = join(this.layout.profileDirectory, "cron", "jobs.json");
    const document = await privateJson(path, { optional: true });
    const jobs = Array.isArray(document) ? document : Array.isArray(document?.jobs) ? document.jobs : [];
    return {
      schema: "foursday-control-schedules/v1",
      items: jobs.slice(0, 1_000).map((job) => normalizedSchedule(job, projectByRoot)),
    };
  }

  async memory() {
    const [projects, config] = await Promise.all([
      projectRegistry(this.registryPath),
      privateJson(this.productionConfigPath),
    ]);
    return {
      schema: "foursday-control-memory/v1",
      sourceId: "default",
      readEnabled: /^(?:1|true|yes)$/iu.test(String(config?.FOURSDAY_GBRAIN_ENABLED ?? "")),
      writeEnabled: /^(?:1|true|yes)$/iu.test(String(config?.FOURSDAY_GBRAIN_WRITE_ENABLED ?? "")),
      projects: projects.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        parentId: project.parentId,
        workspaceId: project.workspaceId,
        pages: project.gbrainSlugs,
      })),
    };
  }

  async evidence() {
    return {
      schema: "foursday-control-evidence/v1",
      ...(await evidenceSummary(this.evidencePath)),
    };
  }

  async apply(input) {
    let taskSeed = null;
    if (!new Set(["pause_all", "resume_all"]).has(input.action)) {
      const value = await this.tasks();
      taskSeed = value.items.find((item) => item.taskId === input.taskId) ?? null;
    }
    return this.store.apply({ ...input, taskSeed });
  }
}

export function controlServicePaths({ layout, environment = process.env } = {}) {
  const stateRoot = join(layout.profileDirectory, "local", "foursday", "state");
  const localRoot = join(layout.profileDirectory, "local", "foursday");
  return {
    controlPath: environment.FOURSDAY_CONTROL_FILE || join(stateRoot, "control.json"),
    registryPath: environment.FOURSDAY_PROJECT_REGISTRY || join(localRoot, "projects.json"),
    threadBindingRoot: environment.FOURSDAY_THREAD_BINDINGS_ROOT || join(stateRoot, "thread-bindings"),
    evidencePath: environment.FOURSDAY_SHADOW_EVIDENCE_FILE || join(stateRoot, "shadow-evidence.jsonl"),
    productionConfigPath: environment.FOURSDAY_PRODUCTION_CONFIG || join(localRoot, "production.json"),
    displayName: basename(layout.profileDirectory),
  };
}
