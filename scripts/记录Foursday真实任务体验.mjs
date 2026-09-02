#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { foursdayExperienceObservationEvents } from "../src/foursday-experience-observation.mjs";

const args = process.argv.slice(2);
const argument = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const observationPath = argument("--observation");
const evidencePath = argument("--evidence");
if (
  !observationPath || !evidencePath ||
  !isAbsolute(observationPath) || !isAbsolute(evidencePath)
) {
  throw new Error(
    "Usage: 记录Foursday真实任务体验.mjs --observation /private/observation.json --evidence /private/events.jsonl",
  );
}

async function readPrivate(path, { optional = false, maximum }) {
  const absolute = resolve(path);
  const canonical = await realpath(absolute).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!canonical) return "";
  if (canonical !== absolute) {
    throw new Error("Foursday experience input must not use a symlink");
  }
  const handle = await open(
    absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return "";
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximum) {
      throw new Error("Foursday experience input must be a private regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const observationText = await readPrivate(observationPath, { maximum: 64 * 1024 });
const observation = JSON.parse(observationText);
const { taskHash, events } = foursdayExperienceObservationEvents(observation);
const existing = await readPrivate(evidencePath, { optional: true, maximum: 32 * 1024 * 1024 });
for (const line of existing.split("\n").filter(Boolean).slice(-100_000)) {
  const event = JSON.parse(line);
  if (event?.taskHash === taskHash) {
    throw new Error("Foursday experience task was already recorded");
  }
}

const destination = resolve(evidencePath);
const parent = dirname(destination);
const existingParent = await lstat(parent).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (!existingParent) await mkdir(parent, { recursive: true, mode: 0o700 });
const parentMetadata = await lstat(parent);
if (
  !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
  (parentMetadata.mode & 0o077) !== 0 || await realpath(parent) !== parent
) throw new Error("Foursday experience evidence directory is unsafe");
const handle = await open(
  destination,
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
  0o600,
);
try {
  const metadata = await handle.stat();
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Foursday experience evidence must be a private regular file");
  }
  const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await handle.writeFile(payload, "utf8");
  await handle.sync();
} finally {
  await handle.close();
}

console.log(JSON.stringify({
  schema: "foursday-experience-record/v1",
  recorded: true,
  taskHash,
  eventCount: events.length,
  privateEvidence: true,
  messagesSent: 0,
}, null, 2));
