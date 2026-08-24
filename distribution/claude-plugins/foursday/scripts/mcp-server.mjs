#!/usr/bin/env node
import { spawn } from "node:child_process";

const command = String(process.env.FOURSDAY_CLI_PATH ?? "foursday").trim();
if (!command || (command.includes("/") && !command.startsWith("/"))) {
  throw new Error("FOURSDAY_CLI_PATH must be an absolute path or omitted");
}
const child = spawn(command, ["control-mcp"], {
  stdio: "inherit",
  env: Object.fromEntries(
    ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "PATH", "FOURSDAY_CONFIG_FILE"]
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  ),
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", () => process.exit(1));
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
