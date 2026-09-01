#!/usr/bin/env node
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { analyzeFoursdayExperience } from "../src/foursday-experience-metrics.mjs";

const args = process.argv.slice(2);
const argument = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const evidencePath = argument("--evidence");
const outputPath = argument("--output");
if (!evidencePath || !isAbsolute(evidencePath) || (outputPath && !isAbsolute(outputPath))) {
  throw new Error("Usage: 验证Foursday真实任务体验.mjs --evidence /private/events.jsonl [--output /private/report.json]");
}
const handle = await open(resolve(evidencePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
let text;
try {
  const metadata = await handle.stat();
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 32 * 1024 * 1024) {
    throw new Error("Foursday experience evidence must be a private regular file");
  }
  text = await handle.readFile("utf8");
} finally { await handle.close(); }
const events = text.split("\n").filter(Boolean).slice(-100_000).map((line) => JSON.parse(line));
const report = analyzeFoursdayExperience(events);
if (outputPath) {
  const destination = resolve(outputPath);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Foursday experience report directory is unsafe");
  }
  const temporary = join(parent, `.foursday-experience-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
console.log(JSON.stringify(report, null, 2));
