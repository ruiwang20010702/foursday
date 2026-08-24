import { createHash } from "node:crypto";
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
import { isAbsolute, join, resolve } from "node:path";

const digest = /^[a-f0-9]{64}$/u;
const threadIdPattern = /^[A-Za-z0-9._:-]{1,500}$/u;
const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Foursday ${label} is invalid`);
  return value;
}

async function privateRoot(root) {
  if (!isAbsolute(root)) throw new Error("Foursday thread binding root must be absolute");
  const absolute = resolve(root);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await chmod(absolute, 0o700);
  const metadata = await lstat(absolute);
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(absolute) !== absolute
  ) throw new Error("Foursday thread binding root is unsafe");
  return absolute;
}

function normalizeScope(context, permissionVersion) {
  if (
    !context ||
    !digest.test(String(context.hermesSessionHash ?? "")) ||
    !digest.test(String(context.sourceSessionHash ?? "")) ||
    !digest.test(String(context.sourcePrincipalHash ?? "")) ||
    !projectIdPattern.test(String(context.projectId ?? "")) ||
    typeof context.workspace !== "string" || !isAbsolute(context.workspace) ||
    !digest.test(String(permissionVersion ?? ""))
  ) throw new Error("Foursday thread binding scope is invalid");
  return {
    hermesSessionHash: context.hermesSessionHash,
    sourceSessionHash: context.sourceSessionHash,
    sourcePrincipalHash: context.sourcePrincipalHash,
    projectId: context.projectId,
    workspace: resolve(context.workspace),
    permissionVersion,
  };
}

function scopeKey(scope) {
  return sha256([
    scope.hermesSessionHash,
    scope.sourceSessionHash,
    scope.sourcePrincipalHash,
    scope.projectId,
    scope.workspace,
    scope.permissionVersion,
  ].join("\0"));
}

async function readBinding(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) {
      throw new Error("Foursday thread binding file is unsafe");
    }
    const document = JSON.parse(await handle.readFile("utf8"));
    if (
      document?.schema !== "foursday-thread-binding/v1" ||
      !digest.test(String(document.key ?? "")) ||
      !threadIdPattern.test(String(document.codexThreadId ?? "")) ||
      !Array.isArray(document.forkThreadIds ?? []) ||
      (document.forkThreadIds ?? []).length > 32 ||
      !(document.forkThreadIds ?? []).every((value) =>
        threadIdPattern.test(String(value)) && value !== document.codexThreadId) ||
      new Set(document.forkThreadIds ?? []).size !== (document.forkThreadIds ?? []).length ||
      !document.scope ||
      !Number.isSafeInteger(document.ownerRevision) || document.ownerRevision < 0 ||
      !Number.isSafeInteger(document.sendGeneration) || document.sendGeneration < 0
    ) throw new Error("Foursday thread binding file is invalid");
    return document;
  } finally {
    await handle.close();
  }
}

async function readThreadOwner(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) {
      throw new Error("Foursday thread owner file is unsafe");
    }
    const document = JSON.parse(await handle.readFile("utf8"));
    if (
      document?.schema !== "foursday-thread-owner/v1" ||
      !digest.test(String(document.scopeKey ?? "")) ||
      !threadIdPattern.test(String(document.codexThreadId ?? ""))
    ) throw new Error("Foursday thread owner file is invalid");
    return document;
  } finally {
    await handle.close();
  }
}

export function foursdayPermissionVersion({ allowedRoots, developerInstructions, runtimeRoots = [] }) {
  const roots = [...allowedRoots].map((value) => resolve(value)).sort();
  const runtimes = [...runtimeRoots].map((value) => resolve(value)).sort();
  return sha256(JSON.stringify({
    schema: "foursday-permission-version/v1",
    roots,
    runtimes,
    developerInstructions: sha256(developerInstructions),
    profile: "foursday-workspace",
  }));
}

export class FoursdayThreadBindingStore {
  constructor({ root }) {
    this.root = root;
    this.absoluteRoot = null;
  }

  async open() {
    this.absoluteRoot = await privateRoot(this.root);
    return this;
  }

  async get(context, permissionVersion) {
    if (!this.absoluteRoot) throw new Error("Foursday thread binding store is not open");
    const scope = normalizeScope(context, permissionVersion);
    const key = scopeKey(scope);
    const document = await readBinding(join(this.absoluteRoot, `${key}.json`));
    if (!document) return null;
    if (document.key !== key || JSON.stringify(document.scope) !== JSON.stringify(scope)) {
      throw new Error("Foursday thread binding scope mismatch");
    }
    if (
      safeInteger(context.ownerRevision, "owner revision") < document.ownerRevision ||
      safeInteger(context.sendGeneration, "send generation") < document.sendGeneration
    ) throw new Error("Foursday thread binding revision is stale");
    for (const threadId of [document.codexThreadId, ...(document.forkThreadIds ?? [])]) {
      const owner = await readThreadOwner(
        join(this.absoluteRoot, `owner-${sha256(threadId)}.json`),
      );
      if (!owner || owner.scopeKey !== key || owner.codexThreadId !== threadId) {
        throw new Error("Foursday thread owner scope mismatch");
      }
    }
    return document;
  }

  async bind(context, permissionVersion, codexThreadId, now = new Date()) {
    if (!this.absoluteRoot) throw new Error("Foursday thread binding store is not open");
    if (!threadIdPattern.test(String(codexThreadId ?? ""))) {
      throw new Error("Foursday Codex thread id is invalid");
    }
    const scope = normalizeScope(context, permissionVersion);
    const key = scopeKey(scope);
    return this.#withLock("store", async () => {
      const path = join(this.absoluteRoot, `${key}.json`);
      const prior = await readBinding(path);
      if (prior && (prior.key !== key || JSON.stringify(prior.scope) !== JSON.stringify(scope))) {
        throw new Error("Foursday thread binding scope mismatch");
      }
      if (prior && prior.codexThreadId !== String(codexThreadId)) {
        throw new Error("Foursday thread binding conflict");
      }
      const ownerRevision = safeInteger(context.ownerRevision, "owner revision");
      const sendGeneration = safeInteger(context.sendGeneration, "send generation");
      if (
        prior &&
        (ownerRevision < prior.ownerRevision || sendGeneration < prior.sendGeneration)
      ) throw new Error("Foursday thread binding revision is stale");
      const document = {
        schema: "foursday-thread-binding/v1",
        key,
        scope,
        codexThreadId: String(codexThreadId),
        forkThreadIds: [...new Set(prior?.forkThreadIds ?? [])],
        ownerRevision,
        sendGeneration,
        updatedAt: now.toISOString(),
      };
      const claim = await this.#claimThread(key, String(codexThreadId), now);
      try {
        return await this.#write(key, document);
      } catch (error) {
        if (claim.created) await unlink(claim.path).catch(() => {});
        throw error;
      }
    });
  }

  async addFork(context, permissionVersion, parentThreadId, forkThreadId, now = new Date()) {
    if (!this.absoluteRoot) throw new Error("Foursday thread binding store is not open");
    for (const [label, value] of Object.entries({ parentThreadId, forkThreadId })) {
      if (!threadIdPattern.test(String(value ?? ""))) {
        throw new Error(`Foursday ${label} is invalid`);
      }
    }
    if (parentThreadId === forkThreadId) throw new Error("Foursday fork thread is invalid");
    const scope = normalizeScope(context, permissionVersion);
    const key = scopeKey(scope);
    return this.#withLock("store", async () => {
      const path = join(this.absoluteRoot, `${key}.json`);
      const prior = await readBinding(path);
      if (!prior || prior.key !== key || JSON.stringify(prior.scope) !== JSON.stringify(scope)) {
        throw new Error("Foursday thread binding scope mismatch");
      }
      const known = new Set([prior.codexThreadId, ...(prior.forkThreadIds ?? [])]);
      if (!known.has(parentThreadId)) throw new Error("Foursday fork parent is not bound");
      known.add(forkThreadId);
      known.delete(prior.codexThreadId);
      if (known.size > 32) throw new Error("Foursday fork limit exceeded");
      const document = {
        ...prior,
        forkThreadIds: [...known].sort(),
        ownerRevision: Math.max(
          prior.ownerRevision,
          safeInteger(context.ownerRevision, "owner revision"),
        ),
        sendGeneration: Math.max(
          prior.sendGeneration,
          safeInteger(context.sendGeneration, "send generation"),
        ),
        updatedAt: now.toISOString(),
      };
      const claim = await this.#claimThread(key, forkThreadId, now);
      try {
        return await this.#write(key, document);
      } catch (error) {
        if (claim.created) await unlink(claim.path).catch(() => {});
        throw error;
      }
    });
  }

  async #claimThread(scopeKeyValue, codexThreadId, now) {
    const digestValue = sha256(codexThreadId);
    const path = join(this.absoluteRoot, `owner-${digestValue}.json`);
    let prior = await readThreadOwner(path);
    if (prior && prior.scopeKey !== scopeKeyValue) {
      const priorBinding = await readBinding(join(this.absoluteRoot, `${prior.scopeKey}.json`));
      if (!priorBinding) {
        await unlink(path);
        prior = null;
      }
    }
    if (prior) {
      if (prior.scopeKey !== scopeKeyValue || prior.codexThreadId !== codexThreadId) {
        throw new Error("Foursday Codex thread belongs to another scope");
      }
      return { document: prior, created: false, path };
    }
    const document = {
      schema: "foursday-thread-owner/v1",
      scopeKey: scopeKeyValue,
      codexThreadId,
      claimedAt: now.toISOString(),
    };
    const temporary = join(this.absoluteRoot, `.owner-${digestValue}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { document, created: true, path };
  }

  async #withLock(key, callback) {
    const lockPath = join(this.absoluteRoot, `.${key}.lock`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let handle;
      let acquired = false;
      try {
        handle = await open(lockPath, "wx", 0o600);
        acquired = true;
        await handle.writeFile(`${process.pid}\n`, "utf8");
        try {
          return await callback();
        } finally {
          await handle.close().catch(() => {});
          await unlink(lockPath).catch(() => {});
        }
      } catch (error) {
        await handle?.close().catch(() => {});
        if (acquired) throw error;
        if (error.code !== "EEXIST") throw error;
        const metadata = await lstat(lockPath).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > 60_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    throw new Error("Foursday thread binding store is busy");
  }

  async #write(key, document) {
    const path = join(this.absoluteRoot, `${key}.json`);
    const temporary = join(this.absoluteRoot, `.${key}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return document;
  }
}
