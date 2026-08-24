#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { FoursdayControlService, controlServicePaths } from "../src/foursday-control-service.mjs";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const layout = foursdayNativeHermesLayout({ projectRoot });
const service = new FoursdayControlService({
  layout,
  ...controlServicePaths({ layout }),
});
const [command = "status", ...flags] = process.argv.slice(2);
const reads = new Map([
  ["status", () => service.status()],
  ["tasks", () => service.tasks()],
  ["schedules", () => service.schedules()],
  ["memory", () => service.memory()],
  ["evidence", () => service.evidence()],
]);
const actionByCommand = new Map([
  ["pause-all", "pause_all"],
  ["resume-all", "resume_all"],
  ["pause-task", "pause_task"],
  ["communication-takeover", "communication_takeover"],
  ["correct-task", "task_correction"],
  ["takeover-task", "task_takeover"],
  ["resume-task", "resume_task"],
]);

function flag(name) {
  const index = flags.indexOf(name);
  return index === -1 ? null : flags[index + 1];
}

let result;
if (reads.has(command)) {
  if (flags.length > 0) throw new Error(`foursday control ${command} does not accept flags`);
  result = await reads.get(command)();
} else if (actionByCommand.has(command)) {
  const supported = new Set(["--revision", "--task", "--note"]);
  if (flags.some((value, index) => index % 2 === 0 && !supported.has(value))) {
    throw new Error("Unsupported Foursday control flag");
  }
  const revision = Number(flag("--revision"));
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("--revision is required");
  result = await service.apply({
    action: actionByCommand.get(command),
    expectedRevision: revision,
    taskId: flag("--task"),
    note: flag("--note") ?? "",
  });
} else {
  throw new Error("Usage: foursday control <status|tasks|schedules|memory|evidence|pause-all|resume-all|pause-task|communication-takeover|correct-task|takeover-task|resume-task>");
}
console.log(JSON.stringify(result, null, 2));
