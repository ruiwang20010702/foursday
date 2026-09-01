import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export const goldenPaths = Object.freeze([
  {
    id: "ordinary_reply",
    label: "普通消息进入与唯一回读回复",
    pattern: "emits allowlisted records and persists a private checkpoint|verifies Markdown-transformed readback without an AI marker",
  },
  {
    id: "fragmented_message",
    label: "六秒碎片使旧回复失效",
    pattern: "outbound quiet window lets a six-second follow-up invalidate the old reply",
  },
  {
    id: "owner_takeover",
    label: "负责人表情接管并阻断AI文本",
    pattern: "owner reaction itself completes external communication without an AI text reply",
  },
  {
    id: "durable_task",
    label: "长任务确认、排队、租约与完成",
    pattern: "durable background execution acknowledges, queues, leases and completes one generation",
  },
  {
    id: "restart_recovery",
    label: "重启只恢复当前代次长任务",
    pattern: "sidecar restart re-emits only a current queued background generation",
  },
]);

function testEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith("FOURSDAY_") &&
    !key.startsWith("DINGTALK_") &&
    !key.startsWith("AI_EMPLOYEE_") &&
    !["DWS_PATH", "DATABASE_URL", "GBRAIN_PATH"].includes(key)
  ));
}

function runPath(path, { root = projectRoot, environment = process.env } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      `--test-name-pattern=${path.pattern}`,
      "test/hermes-dws-sidecar.test.mjs",
    ], {
      cwd: root,
      env: testEnvironment(environment),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(
        signal
          ? `黄金路径 ${path.id} 被 ${signal} 中断`
          : `黄金路径 ${path.id} 失败，退出码 ${code}`,
      ));
    });
  });
}

export async function verifyGoldenPaths(options = {}) {
  for (const path of goldenPaths) {
    process.stdout.write(`\n[golden:${path.id}] ${path.label}\n`);
    await runPath(path, options);
  }
  return { valid: true, paths: goldenPaths.map(({ id, label }) => ({ id, label })) };
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await verifyGoldenPaths(), null, 2));
}
