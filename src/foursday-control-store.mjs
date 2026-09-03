import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const digest = /^[a-f0-9]{64}$/u;
const projectId = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const taskStates = new Set(["active", "paused", "taken_over"]);
const requesterChannels = new Set(["dingtalk_direct", "dingtalk_group"]);
const actions = new Set([
  "pause_all", "resume_all", "pause_task", "communication_takeover",
  "task_correction", "task_takeover", "resume_task",
]);
const noWrite = (result) => ({ __noWrite: true, result });

function emptyDocument() {
  return {
    schema: "foursday-control/v1",
    revision: 0,
    global: { state: "running", updatedAt: null },
    tasks: {},
  };
}

function safeNote(value) {
  const note = String(value ?? "").trim();
  if (note.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)) {
    throw new Error("Foursday control note is invalid");
  }
  if (
    /(?:password|secret|token|authorization|private[ _-]?key)\s*[:=]/iu.test(note) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{10,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)?:\/\/\S+|\bfctx_[a-f0-9]{64}\b/iu.test(note)
  ) {
    throw new Error("Foursday control note may contain secret material");
  }
  return note;
}

function normalizeRequester(value) {
  if (value == null) return null;
  const displayName = String(value?.displayName ?? "").trim();
  const channel = String(value?.channel ?? "");
  if (
    !displayName || displayName.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(displayName) ||
    /(?:password|secret|token|authorization|private[ _-]?key)\s*[:=]/iu.test(displayName) ||
    !requesterChannels.has(channel)
  ) throw new Error("Foursday requester projection is invalid");
  return { displayName, channel };
}

function normalizeTask(value, key) {
  if (
    !value || typeof value !== "object" || value.taskId !== key || !digest.test(key) ||
    !taskStates.has(value.state) || !Number.isSafeInteger(value.ownerRevision) ||
    value.ownerRevision < 0 || !Number.isSafeInteger(value.sendGeneration) ||
    value.sendGeneration < 0
  ) throw new Error("Foursday control task is invalid");
  if (value.projectId != null && !projectId.test(String(value.projectId))) {
    throw new Error("Foursday control task project is invalid");
  }
  const event = value.pendingEvent;
  if (event != null && (
    typeof event !== "object" || typeof event.id !== "string" || event.id.length > 100 ||
    !new Set([
      "communication_takeover", "task_correction", "task_takeover", "resume_requested",
    ]).has(event.type) || typeof event.note !== "string" || event.note.length > 2_000 ||
    typeof event.createdAt !== "string" || typeof event.consumed !== "boolean"
  )) throw new Error("Foursday control event is invalid");
  return {
    taskId: key,
    projectId: value.projectId == null ? null : String(value.projectId),
    requester: normalizeRequester(value.requester),
    state: value.state,
    ownerRevision: value.ownerRevision,
    sendGeneration: value.sendGeneration,
    lastInboundAt: typeof value.lastInboundAt === "string" ? value.lastInboundAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    pendingEvent: event == null ? null : { ...event },
  };
}

function normalizeDocument(value) {
  if (
    !value || value.schema !== "foursday-control/v1" ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !value.global || !["running", "paused"].includes(value.global.state) ||
    !value.tasks || Array.isArray(value.tasks) || typeof value.tasks !== "object" ||
    Object.keys(value.tasks).length > 1_000
  ) throw new Error("Foursday control file is invalid");
  return {
    schema: value.schema,
    revision: value.revision,
    global: {
      state: value.global.state,
      updatedAt: typeof value.global.updatedAt === "string" ? value.global.updatedAt : null,
    },
    tasks: Object.fromEntries(Object.entries(value.tasks).map(([key, task]) => [
      key,
      normalizeTask(task, key),
    ])),
  };
}

async function privateParent(path) {
  const parent = resolve(dirname(path));
  const prior = await lstat(parent).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!prior) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
  }
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(parent) !== parent ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) throw new Error("Foursday control parent is unsafe");
  return parent;
}

async function readDocument(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return emptyDocument();
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new Error("Foursday control file is unsafe");
    }
    return normalizeDocument(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

export class FoursdayControlStore {
  constructor({ path }) {
    if (!isAbsolute(path)) throw new Error("Foursday control path must be absolute");
    this.path = resolve(path);
    this.parent = null;
  }

  async open({ createParent = false } = {}) {
    if (createParent) this.parent = await privateParent(this.path);
    return this;
  }

  async snapshot() {
    return readDocument(this.path);
  }

  async observeTask({
    taskId,
    projectId: project,
    requester = null,
    ownerRevision,
    sendGeneration,
    lastInboundAt,
  }) {
    const normalizedRequester = normalizeRequester(requester);
    if (
      !digest.test(String(taskId ?? "")) ||
      (project != null && !projectId.test(String(project))) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0 ||
      typeof lastInboundAt !== "string"
    ) {
      throw new Error("Foursday observed task identity is invalid");
    }
    return this.#mutate((document, timestamp) => {
      const prior = document.tasks[taskId] ?? {
        taskId,
        projectId: project ?? null,
        requester: null,
        state: "active",
        ownerRevision: 0,
        sendGeneration: 0,
        lastInboundAt: null,
        updatedAt: null,
        pendingEvent: null,
      };
      document.tasks[taskId] = {
        ...prior,
        projectId: project ?? prior.projectId,
        requester: normalizedRequester ?? prior.requester,
        ownerRevision: Math.max(prior.ownerRevision, ownerRevision),
        sendGeneration: Math.max(prior.sendGeneration, sendGeneration),
        lastInboundAt,
        updatedAt: timestamp,
      };
      return document.tasks[taskId];
    });
  }

  async reassignTaskProject({
    taskId,
    projectId: project,
    ownerRevision,
    sendGeneration,
  }) {
    if (
      !digest.test(String(taskId ?? "")) || !projectId.test(String(project ?? "")) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday task project reassignment is invalid");
    return this.#mutate((document, timestamp) => {
      const task = document.tasks[taskId];
      if (!task) throw new Error("foursday_control_task_not_found");
      if (
        task.ownerRevision !== ownerRevision || task.sendGeneration !== sendGeneration
      ) throw new Error("foursday_control_task_revision_conflict");
      if (task.projectId === project) {
        return noWrite({ reassigned: false, task: { ...task } });
      }
      task.projectId = project;
      task.updatedAt = timestamp;
      return { reassigned: true, task: { ...task } };
    });
  }

  async reopenTakenOverTask({
    taskId,
    expectedOwnerRevision,
    expectedSendGeneration,
    lastInboundAt,
  }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      !Number.isSafeInteger(expectedOwnerRevision) || expectedOwnerRevision < 0 ||
      !Number.isSafeInteger(expectedSendGeneration) || expectedSendGeneration < 0 ||
      typeof lastInboundAt !== "string" || !Number.isFinite(new Date(lastInboundAt).getTime())
    ) throw new Error("Foursday task reopen identity is invalid");
    return this.#mutate((document, timestamp) => {
      const task = document.tasks[taskId];
      if (!task) throw new Error("foursday_control_task_not_found");
      if (task.state === "active") {
        return noWrite({ reopened: false, alreadyActive: true, task: { ...task } });
      }
      if (
        task.state !== "taken_over" ||
        task.ownerRevision !== expectedOwnerRevision ||
        task.sendGeneration !== expectedSendGeneration
      ) throw new Error("foursday_control_task_revision_conflict");
      task.state = "active";
      task.ownerRevision += 1;
      task.sendGeneration += 1;
      task.lastInboundAt = lastInboundAt;
      task.updatedAt = timestamp;
      task.pendingEvent = null;
      return {
        reopened: true,
        alreadyActive: false,
        task: { ...task },
      };
    });
  }

  async apply({ action, expectedRevision, taskId = null, note = "", taskSeed = null }) {
    if (!actions.has(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Foursday control action is invalid");
    }
    const normalizedNote = safeNote(note);
    return this.#mutate((document, timestamp) => {
      if (document.revision !== expectedRevision) throw new Error("foursday_control_revision_conflict");
      if (["pause_all", "resume_all"].includes(action)) {
        const paused = action === "pause_all";
        document.global = {
          state: paused ? "paused" : "running",
          updatedAt: timestamp,
        };
        for (const task of Object.values(document.tasks)) {
          if (task.state !== "active") continue;
          task.ownerRevision += 1;
          task.sendGeneration += 1;
          task.updatedAt = timestamp;
          task.pendingEvent = {
            id: randomUUID(),
            type: paused ? "task_takeover" : "resume_requested",
            note: paused ? "" : "Continue the paused task from its current verified evidence.",
            createdAt: timestamp,
            consumed: false,
          };
        }
        return {
          target: "global",
          state: document.global.state,
          affectedTasks: Object.keys(document.tasks).length,
        };
      }
      if (!digest.test(String(taskId ?? ""))) {
        throw new Error("foursday_control_task_not_found");
      }
      if (!document.tasks[taskId] && taskSeed?.taskId === taskId) {
        document.tasks[taskId] = {
          taskId,
          projectId: projectId.test(String(taskSeed.projectId ?? "")) ? taskSeed.projectId : null,
          requester: null,
          state: "active",
          ownerRevision: Number.isSafeInteger(taskSeed.ownerRevision) ? taskSeed.ownerRevision : 0,
          sendGeneration: Number.isSafeInteger(taskSeed.sendGeneration) ? taskSeed.sendGeneration : 0,
          lastInboundAt: null,
          updatedAt: timestamp,
          pendingEvent: null,
        };
      }
      if (!document.tasks[taskId]) throw new Error("foursday_control_task_not_found");
      const task = document.tasks[taskId];
      const eventType = {
        pause_task: "task_takeover",
        communication_takeover: "communication_takeover",
        task_correction: "task_correction",
        task_takeover: "task_takeover",
        resume_task: "resume_requested",
      }[action];
      const state = action === "pause_task"
        ? "paused"
        : action === "task_takeover"
          ? "taken_over"
          : "active";
      task.state = state;
      task.ownerRevision += 1;
      task.sendGeneration += 1;
      task.updatedAt = timestamp;
      const eventNote = normalizedNote || (action === "resume_task"
        ? "Continue the paused task from its current verified evidence."
        : "");
      if (action === "task_correction" && !eventNote) {
        throw new Error("Foursday task correction requires a note");
      }
      task.pendingEvent = {
        id: randomUUID(),
        type: eventType,
        note: eventNote,
        createdAt: timestamp,
        consumed: false,
      };
      return {
        target: "task",
        taskId,
        state,
        ownerRevision: task.ownerRevision,
        sendGeneration: task.sendGeneration,
        eventId: task.pendingEvent.id,
      };
    });
  }

  async consumeEvent(taskId, eventId) {
    return this.#mutate((document, timestamp) => {
      const task = document.tasks[taskId];
      if (!task || task.pendingEvent?.id !== eventId) return noWrite({ consumed: false });
      if (task.pendingEvent.consumed) return noWrite({ consumed: true, taskId, eventId });
      task.pendingEvent.consumed = true;
      task.pendingEvent.note = "";
      task.updatedAt = timestamp;
      return { consumed: true, taskId, eventId };
    });
  }

  async recordIntervention({ taskId, type, ownerRevision, sendGeneration, occurredAt }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      !new Set([
        "communication_takeover", "task_correction", "task_takeover", "resume_requested",
      ]).has(type) || !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday recorded intervention is invalid");
    return this.#mutate((document, timestamp) => {
      const task = document.tasks[taskId] ?? {
        taskId,
        projectId: null,
        requester: null,
        state: "active",
        ownerRevision: 0,
        sendGeneration: 0,
        lastInboundAt: null,
        updatedAt: null,
        pendingEvent: null,
      };
      document.tasks[taskId] = task;
      task.state = type === "task_takeover" ? "taken_over" : "active";
      task.ownerRevision = Math.max(task.ownerRevision, ownerRevision);
      task.sendGeneration = Math.max(task.sendGeneration, sendGeneration);
      task.updatedAt = timestamp;
      task.pendingEvent = null;
      return { recorded: true, taskId, type, occurredAt };
    });
  }

  async #mutate(callback) {
    if (!this.parent) this.parent = await privateParent(this.path);
    const lockPath = `${this.path}.lock`;
    let lock;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const metadata = await lstat(lockPath).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > 60_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    if (!lock) throw new Error("Foursday control store is busy");
    try {
      const document = await readDocument(this.path);
      const timestamp = new Date().toISOString();
      const result = callback(document, timestamp);
      if (result?.__noWrite === true) {
        return { revision: document.revision, result: result.result, document };
      }
      document.revision += 1;
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, this.path);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
      return { revision: document.revision, result, document };
    } finally {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }
}
