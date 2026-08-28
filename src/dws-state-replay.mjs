import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

function boundedMessageIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) {
    throw new Error("DWS replay requires one to thirty-two message IDs");
  }
  const ids = [...new Set(values.map((value) => String(value ?? "").trim()))];
  if (
    ids.length !== values.length ||
    ids.some((value) => !value || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value))
  ) throw new Error("DWS replay message IDs are invalid");
  return ids;
}

async function privateStateFile(value) {
  if (!isAbsolute(String(value ?? ""))) throw new Error("DWS replay state path must be absolute");
  const path = resolve(value);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || metadata.size > 16 * 1024 * 1024 ||
    await realpath(path) !== path ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) throw new Error("DWS replay state file is unsafe");
  return path;
}

async function writePrivateFile(path, content) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

export async function replayDwsMessages({
  stateFile,
  messageIds,
  before,
  apply = false,
  now = new Date(),
} = {}) {
  const path = await privateStateFile(stateFile);
  const ids = boundedMessageIds(messageIds);
  const beforeTime = new Date(before).getTime();
  if (!Number.isFinite(beforeTime)) throw new Error("DWS replay boundary is invalid");
  const raw = await readFile(path, "utf8");
  const state = JSON.parse(raw);
  if (!Array.isArray(state.recentMessageIds)) throw new Error("DWS replay state is invalid");
  const recent = new Set(state.recentMessageIds.map(String));
  const found = ids.filter((id) => recent.has(id));
  if (found.length !== ids.length) throw new Error("DWS replay message is not in the processed ledger");
  const currentCheckpoint = new Date(state.lastEnterpriseAt).getTime();
  const rewindTime = Math.max(0, beforeTime - 5_000);
  const replayCheckpoint = new Date(rewindTime).toISOString();
  const nextCheckpoint = Number.isFinite(currentCheckpoint)
    ? new Date(Math.min(currentCheckpoint, rewindTime)).toISOString()
    : replayCheckpoint;
  const plan = {
    schema: "foursday-dws-message-replay/v1",
    apply,
    messagesRequested: ids.length,
    messagesFound: found.length,
    checkpointRewound: nextCheckpoint !== state.lastEnterpriseAt,
    productionMessageSent: false,
  };
  if (!apply) return plan;

  state.recentMessageIds = state.recentMessageIds.filter((id) => !ids.includes(String(id)));
  state.lastEnterpriseAt = nextCheckpoint;
  const timestamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const backupPath = `${path}.replay-backup-${timestamp}`;
  const temporary = `${path}.replay-${process.pid}-${Date.now()}.tmp`;
  await writePrivateFile(backupPath, raw);
  try {
    await writePrivateFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    await rename(backupPath, path).catch(() => {});
    throw error;
  }
  return {
    ...plan,
    apply: true,
    backupPath,
    stateDirectory: dirname(path),
  };
}
