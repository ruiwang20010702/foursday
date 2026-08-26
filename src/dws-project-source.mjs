import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dingtalkNodeId = /^[A-Za-z0-9]{20,80}$/u;

function dwsEnvironment(dwsPath, environment) {
  const home = String(environment.FOURSDAY_DWS_HOME ?? "").trim();
  if (!isAbsolute(home)) throw new Error("project_source_unavailable");
  return {
    HOME: home,
    PATH: [dirname(dwsPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
}

export async function fetchDwsProjectDocument({
  dwsPath,
  nodeId,
  keyword = null,
  environment = process.env,
  run = execFileAsync,
  timeoutMs = 8_000,
  maxBuffer = 2 * 1024 * 1024,
} = {}) {
  if (!isAbsolute(String(dwsPath ?? "")) || !dingtalkNodeId.test(String(nodeId ?? ""))) {
    throw new Error("project_source_unavailable");
  }
  const executable = await realpath(dwsPath).catch(() => null);
  if (!executable) throw new Error("project_source_unavailable");
  await access(executable, constants.X_OK).catch(() => {
    throw new Error("project_source_unavailable");
  });
  const args = ["doc", "+fetch", "--node", nodeId, "--format", "json", "--timeout", "8"];
  if (keyword) args.push("--keyword", keyword);
  let stdout;
  try {
    ({ stdout } = await run(executable, args, {
      env: dwsEnvironment(executable, environment),
      timeout: timeoutMs,
      maxBuffer,
    }));
  } catch {
    throw new Error("project_source_read_failed");
  }
  let payload;
  try {
    payload = JSON.parse(String(stdout));
  } catch {
    throw new Error("project_source_read_failed");
  }
  const content = payload?.content;
  if (
    payload?.complete !== true || payload?.status !== "success" ||
    content?.success !== true || content?.nodeId !== nodeId ||
    typeof content?.markdown !== "string" || content.markdown.trim() === ""
  ) throw new Error("project_source_read_failed");
  return {
    title: String(content.title ?? "").trim().slice(0, 200),
    markdown: content.markdown,
  };
}
