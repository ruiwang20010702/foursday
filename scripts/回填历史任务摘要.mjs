#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FoursdayControlService, controlServicePaths } from "../src/foursday-control-service.mjs";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";
import { resolveTaskSummary } from "../src/foursday-task-summary.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((value) => value !== "--apply")) {
  throw new Error("Usage: node scripts/回填历史任务摘要.mjs [--apply]");
}
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const layout = foursdayNativeHermesLayout({ projectRoot });
const paths = controlServicePaths({ layout });
const service = new FoursdayControlService({ layout, ...paths });
const snapshot = await service.tasks();
const candidates = snapshot.items.filter((task) =>
  !task.taskContract && !task.summaryTitle && task.codexThreadId &&
  task.assignmentState !== "legacy_unassigned");
const result = {
  schema: "foursday-task-summary-backfill/v1",
  apply,
  candidateCount: candidates.length,
  summarizedCount: 0,
  skippedCount: 0,
  writes: 0,
};

if (apply) {
  const configured = {};
  await applyProductionConfigFile({
    path: paths.productionConfigPath,
    environment: configured,
    resolveSecrets: false,
  });
  const environment = {
    ...process.env,
    CODEX_HOME: join(layout.profileDirectory, "local", "foursday", "codex"),
    FOURSDAY_CODEX_PATH: configured.FOURSDAY_CODEX_PATH,
    FOURSDAY_PROJECT_REGISTRY: paths.registryPath,
    FOURSDAY_FALLBACK_WORKSPACE: join(layout.profileDirectory, "local", "foursday", "fallback"),
  };
  const sessionsRoot = join(layout.profileDirectory, "local", "foursday", "codex", "sessions");
  for (const task of candidates) {
    const summary = await resolveTaskSummary({
      sessionsRoot,
      codexThreadId: task.codexThreadId,
      targetAt: task.lastInboundAt ?? task.updatedAt,
      projectName: task.projectName ?? task.projectGroupName,
    }, { environment });
    if (!summary) {
      result.skippedCount += 1;
      continue;
    }
    const update = await service.taskLedgerStore.recordSummary({
      taskId: task.taskId,
      title: summary.title,
      ownerRevision: task.ownerRevision,
      sendGeneration: task.sendGeneration,
    });
    result.summarizedCount += 1;
    result.writes += update.result.updated ? 1 : 0;
  }
}

console.log(JSON.stringify(result, null, 2));
