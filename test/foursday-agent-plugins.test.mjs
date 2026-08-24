import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const codexRoot = new URL("../plugins/foursday/", import.meta.url);
const claudeRoot = new URL("../distribution/claude-plugins/foursday/", import.meta.url);

test("Codex and Claude plugins are thin clients for the same Foursday Control MCP", async () => {
  const [codexManifest, codexMcp, codexSkill, codexScript, claudeManifest, claudeMcp, claudeSkill, claudeScript] = await Promise.all([
    readFile(new URL(".codex-plugin/plugin.json", codexRoot), "utf8").then(JSON.parse),
    readFile(new URL(".mcp.json", codexRoot), "utf8").then(JSON.parse),
    readFile(new URL("skills/foursday/SKILL.md", codexRoot), "utf8"),
    readFile(new URL("scripts/mcp-server.mjs", codexRoot), "utf8"),
    readFile(new URL(".claude-plugin/plugin.json", claudeRoot), "utf8").then(JSON.parse),
    readFile(new URL(".mcp.json", claudeRoot), "utf8").then(JSON.parse),
    readFile(new URL("skills/foursday/SKILL.md", claudeRoot), "utf8"),
    readFile(new URL("scripts/mcp-server.mjs", claudeRoot), "utf8"),
  ]);
  assert.equal(codexManifest.name, "foursday");
  assert.equal(claudeManifest.name, "foursday");
  assert.equal(codexManifest.interface.composerIcon, "./assets/icon.png");
  assert.equal(codexManifest.interface.logo, "./assets/icon.png");
  assert.equal(codexManifest.interface.logoDark, "./assets/icon.png");
  assert.deepEqual(codexMcp, claudeMcp);
  assert.equal(codexScript, claudeScript);
  assert.match(codexScript, /\["control-mcp"\]/u);
  for (const skill of [codexSkill, claudeSkill]) {
    assert.match(skill, /revision/u);
    assert.match(skill, /foursday_status/u);
    assert.match(skill, /foursday_control/u);
    assert.match(skill, /9465.*不.*权威/u);
  }
});

test("package publishes both agent plugin distributions", async () => {
  const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(packageDocument.files.includes("plugins/foursday/"));
  assert.ok(packageDocument.files.includes("distribution/claude-plugins/"));
  assert.ok(packageDocument.files.includes(".agents/plugins/marketplace.json"));
  assert.ok(packageDocument.files.includes(".claude-plugin/marketplace.json"));
});

test("Codex and Claude marketplaces expose the current thin plugins", async () => {
  const codexMarketplace = JSON.parse(await readFile(
    new URL("../.agents/plugins/marketplace.json", import.meta.url),
    "utf8",
  ));
  const claudeMarketplace = JSON.parse(await readFile(
    new URL("../.claude-plugin/marketplace.json", import.meta.url),
    "utf8",
  ));
  assert.equal(codexMarketplace.name, "foursday-local");
  assert.equal(codexMarketplace.plugins[0].source.path, "./plugins/foursday");
  assert.equal(claudeMarketplace.name, "foursday-local");
  assert.equal(claudeMarketplace.plugins[0].source, "./distribution/claude-plugins/foursday");
});

test("Codex plugin wrapper launches the shared Foursday control MCP", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("scripts/mcp-server.mjs", codexRoot))], {
    cwd: codexRoot,
    env: {
      ...process.env,
      FOURSDAY_CLI_PATH: fileURLToPath(new URL("../scripts/新环境向导.mjs", import.meta.url)),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
  child.stdin.end();
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  const response = JSON.parse(Buffer.concat(output).toString("utf8").trim());
  assert.equal(response.result.tools.at(-1).name, "foursday_control");
});
