import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const text = (path) => readFile(resolve(root, path), "utf8");

test("README presents Foursday as the product and Codex as the only work loop", async () => {
  const readme = await text("README.md");
  assert.match(readme, /Codex Agent Loop/u);
  assert.match(readme, /pinned, minimally installed.*Hermes.*control plane/isu);
  assert.match(readme, /personal-memory-driven work twin/iu);
  assert.doesNotMatch(readme, /Native Hermes Agent Loop|Hermes \+ Codex|Gate 2|legacy runtime runbook|production deployments/iu);
});

test("package maintenance scripts use the Foursday runtime namespace", async () => {
  const packageJson = JSON.parse(await text("package.json"));
  assert.deepEqual(packageJson.bin, { foursday: "scripts/新环境向导.mjs" });
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), [
    "check",
    "check:full",
    "check:python",
    "check:security",
    "memory:promote",
    "reuse:verify",
    "runtime:accept",
    "runtime:activate",
    "runtime:configure",
    "runtime:gateway",
    "runtime:setup",
    "runtime:verify-mcp",
  ]);
  assert.equal(packageJson.dependencies["@larksuiteoapi/node-sdk"], undefined);
});

test("private attachment staging can never become an ordinary Git candidate", async () => {
  const gitignore = await text(".gitignore");
  assert.match(gitignore, /^\.foursday-inbox\/$/mu);
});

test("documentation tree has one small current set and no history mirror", async () => {
  const files = async (directory) => (await readdir(resolve(root, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(await files("docs"), ["产品需求文档.md", "技术设计文档.md", "设计总览.md"]);
  assert.deepEqual(await files("docs/en"), ["architecture.md", "deployment.md", "integrations.md"]);
  assert.deepEqual(await files("docs/指南"), ["中文首页.md", "参与贡献.md", "同企业真实工作灰度测试指南.md", "安全说明.md", "生产迁移与回滚.md", "集成扩展指南.md"]);
  const history = await readdir(resolve(root, "docs/历史")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(history, []);
});

test("current Markdown links resolve locally", async () => {
  const paths = [
    "README.md", "CONTRIBUTING.md", "SECURITY.md",
    "docs/产品需求文档.md", "docs/技术设计文档.md", "docs/设计总览.md",
    "docs/en/architecture.md", "docs/en/deployment.md", "docs/en/integrations.md",
    "docs/指南/中文首页.md", "docs/指南/参与贡献.md", "docs/指南/同企业真实工作灰度测试指南.md", "docs/指南/安全说明.md",
    "docs/指南/生产迁移与回滚.md", "docs/指南/集成扩展指南.md",
  ];
  for (const path of paths) {
    const document = await text(path);
    for (const match of document.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const clean = decodeURIComponent(target.split("#")[0]);
      await access(resolve(root, dirname(path), clean));
    }
  }
});

test("architecture docs use diagrams and the minimal storage model", async () => {
  for (const path of ["README.md", "docs/技术设计文档.md", "docs/设计总览.md"]) {
    assert.match(await text(path), /```mermaid/u);
  }
  const design = await text("docs/技术设计文档.md");
  assert.match(design, /db\/schema\.sql/u);
  assert.doesNotMatch(design, /listener\.mjs|worker\.mjs|plan-executor\.mjs|hermes\/patches/u);
});

test("public examples use the minimal FOURSDAY configuration contract", async () => {
  const example = JSON.parse(await text("deploy/foursday.example.json"));
  assert.ok(Object.keys(example).every((key) => key.startsWith("FOURSDAY_")));
  assert.equal(example.FOURSDAY_GBRAIN_WRITE_ENABLED, false);
  assert.match(example.FOURSDAY_DATABASE_URL, /^keychain:\/\//u);
  assert.doesNotMatch(JSON.stringify(example), /AI_EMPLOYEE_|"DATABASE_URL":/u);
});

test("social preview remains the GitHub recommended size", async () => {
  const image = await readFile(resolve(root, "assets/foursday-social-preview.png"));
  assert.equal(image.readUInt32BE(16), 1280);
  assert.equal(image.readUInt32BE(20), 640);
});
