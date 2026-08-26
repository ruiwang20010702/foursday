import { randomUUID } from "node:crypto";
import {
  lstat, mkdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function safeLockPath(value) {
  if (!isAbsolute(String(value ?? ""))) throw new Error("dws_command_lock_invalid");
  const lockPath = resolve(String(value));
  const parent = dirname(lockPath);
  const canonicalParent = await realpath(parent).catch(() => null);
  if (canonicalParent !== parent) throw new Error("dws_command_lock_invalid");
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("dws_command_lock_invalid");
  }
  return lockPath;
}

export async function withDwsCommandLock(lockPathValue, action, {
  timeoutMs = 10_000,
  pollMs = 50,
  staleMs = 120_000,
} = {}) {
  if (typeof action !== "function") throw new Error("dws_command_lock_invalid");
  if (!lockPathValue) return action();
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 1_000 ||
    !Number.isSafeInteger(staleMs) || staleMs < 60_000 || staleMs > 10 * 60_000
  ) throw new Error("dws_command_lock_invalid");
  const lockPath = await safeLockPath(lockPathValue);
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  const ownerPath = join(lockPath, "owner");
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(ownerPath, `${ownerToken}\n`, { mode: 0o600, flag: "wx" });
      } catch {
        await rmdir(lockPath).catch(() => {});
        throw new Error("dws_command_lock_invalid");
      }
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw new Error("dws_command_lock_invalid");
      const metadata = await lstat(lockPath).catch(() => null);
      if (!metadata) continue;
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("dws_command_lock_invalid");
      }
      if (Date.now() - metadata.mtimeMs > staleMs) {
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (!["ENOENT", "EEXIST"].includes(staleError.code)) {
            throw new Error("dws_command_lock_invalid");
          }
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const busy = new Error("dws_command_busy");
        busy.code = "dws_command_busy";
        throw busy;
      }
      await delay(pollMs);
    }
  }
  try {
    return await action();
  } finally {
    const currentOwner = await readFile(ownerPath, "utf8").catch(() => null);
    if (currentOwner?.trim() === ownerToken) {
      await unlink(ownerPath);
      await rmdir(lockPath);
    }
  }
}
