import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const digest = /^[a-f0-9]{64}$/u;
const projectId = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const lifecycleStates = new Set([
  "intake", "planning", "working", "verifying", "waiting_acceptance",
  "rework_requested", "escalated", "failed", "accepted",
]);
const agentLifecycleStates = new Set([...lifecycleStates].filter((value) => value !== "accepted"));
const evidenceKinds = new Set([
  "message", "memory", "source", "file", "tool", "test", "delivery", "runtime",
]);
const evidenceStates = new Set(["observed", "verified", "missing"]);
const secretMaterial = /(?:password|secret|token|authorization|private[ _-]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{10,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)?:\/\/\S+|\bfctx_[a-f0-9]{64}\b/iu;

function boundedText(value, maximum, name, { required = true } = {}) {
  const text = String(value ?? "").replace(/\0/gu, "").trim();
  if (
    (required && !text) || text.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
    secretMaterial.test(text)
  ) throw new Error(`Foursday task ledger ${name} is invalid`);
  return text;
}

function boundedList(value, maximumItems, maximumLength, name) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`Foursday task ledger ${name} is invalid`);
  }
  return value.map((item) => boundedText(item, maximumLength, name));
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("Foursday task ledger evidence is invalid");
  }
  return value.map((item) => {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      !evidenceKinds.has(item.kind) || !evidenceStates.has(item.status)
    ) throw new Error("Foursday task ledger evidence is invalid");
    return {
      kind: item.kind,
      status: item.status,
      summary: boundedText(item.summary, 240, "evidence summary"),
    };
  });
}

function normalizeTask(value, key) {
  if (
    !value || typeof value !== "object" || !digest.test(key) || value.taskId !== key ||
    !agentLifecycleStates.has(value.lifecycleState) && value.lifecycleState !== "accepted" ||
    !Number.isSafeInteger(value.ownerRevision) || value.ownerRevision < 0 ||
    !Number.isSafeInteger(value.sendGeneration) || value.sendGeneration < 0 ||
    !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
  ) throw new Error("Foursday task ledger task is invalid");
  if (value.projectId != null && !projectId.test(String(value.projectId))) {
    throw new Error("Foursday task ledger project is invalid");
  }
  return {
    taskId: key,
    projectId: value.projectId == null ? null : String(value.projectId),
    title: boundedText(value.title, 120, "title"),
    goal: boundedText(value.goal, 1_000, "goal"),
    deliverables: boundedList(value.deliverables, 8, 200, "deliverables"),
    acceptanceCriteria: boundedList(value.acceptanceCriteria, 8, 240, "acceptance criteria"),
    lifecycleState: value.lifecycleState,
    confidence: Number(value.confidence),
    evidence: normalizeEvidence(value.evidence),
    ownerRevision: value.ownerRevision,
    sendGeneration: value.sendGeneration,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function emptyDocument() {
  return { schema: "foursday-task-ledger/v1", revision: 0, tasks: {} };
}

function normalizeDocument(value) {
  if (
    !value || value.schema !== "foursday-task-ledger/v1" ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !value.tasks || typeof value.tasks !== "object" || Array.isArray(value.tasks) ||
    Object.keys(value.tasks).length > 1_000
  ) throw new Error("Foursday task ledger file is invalid");
  return {
    schema: value.schema,
    revision: value.revision,
    tasks: Object.fromEntries(Object.entries(value.tasks).map(([key, task]) => [
      key, normalizeTask(task, key),
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
  ) throw new Error("Foursday task ledger parent is unsafe");
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
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 2 * 1024 * 1024 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("Foursday task ledger file is unsafe");
    return normalizeDocument(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

export class FoursdayTaskLedgerStore {
  constructor({ path }) {
    if (!isAbsolute(path)) throw new Error("Foursday task ledger path must be absolute");
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

  async upsertFromAgent({
    taskId,
    projectId: project,
    title,
    goal,
    deliverables = [],
    acceptanceCriteria = [],
    lifecycleState,
    confidence,
    evidence = [],
    ownerRevision,
    sendGeneration,
  }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      (project != null && !projectId.test(String(project))) ||
      !agentLifecycleStates.has(lifecycleState) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday task ledger update is invalid");
    const candidate = normalizeTask({
      taskId,
      projectId: project,
      title,
      goal,
      deliverables,
      acceptanceCriteria,
      lifecycleState,
      confidence: Number(confidence),
      evidence,
      ownerRevision,
      sendGeneration,
      updatedAt: new Date().toISOString(),
    }, taskId);
    if (
      lifecycleState === "waiting_acceptance" &&
      !candidate.evidence.some((item) => item.status === "verified")
    ) throw new Error("Foursday task ledger waiting acceptance requires verified evidence");
    return this.#mutate((document, timestamp) => {
      const prior = document.tasks[taskId];
      if (
        prior && (
          ownerRevision < prior.ownerRevision ||
          (ownerRevision === prior.ownerRevision && sendGeneration < prior.sendGeneration)
        )
      ) throw new Error("foursday_task_ledger_revision_conflict");
      document.tasks[taskId] = { ...candidate, updatedAt: timestamp };
      return { task: { ...document.tasks[taskId] } };
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
    if (!lock) throw new Error("Foursday task ledger is busy");
    try {
      const document = await readDocument(this.path);
      const result = callback(document, new Date().toISOString());
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
