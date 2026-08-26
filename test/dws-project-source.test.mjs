import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchDwsProjectDocument,
  inspectDwsProjectNode,
} from "../src/dws-project-source.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-source-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dwsPath = join(root, "dws");
  await writeFile(dwsPath, "#!/bin/sh\n", { mode: 0o700 });
  return { root, dwsPath, nodeId: "EXAMPLEPROJECTDOCNODE1234567890" };
}

test("DWS project source uses one exact read-only document command", async (t) => {
  const value = await fixture(t);
  let observed;
  const result = await fetchDwsProjectDocument({
    dwsPath: value.dwsPath,
    nodeId: value.nodeId,
    keyword: "milestone",
    environment: {
      FOURSDAY_DWS_HOME: value.root,
      DATABASE_URL: "postgresql://must-not-leak",
      DINGTALK_SECRET: "must-not-leak",
    },
    run: async (command, args, options) => {
      observed = { command, args, options };
      return { stdout: JSON.stringify({
        complete: true,
        status: "success",
        content: {
          success: true,
          nodeId: value.nodeId,
          title: "Current project source",
          markdown: "# Current evidence\n",
        },
      }) };
    },
  });
  assert.equal(result.title, "Current project source");
  assert.equal(result.markdown, "# Current evidence\n");
  assert.equal(observed.command, value.dwsPath);
  assert.deepEqual(observed.args, [
    "doc", "+fetch", "--node", value.nodeId,
    "--format", "json", "--timeout", "8", "--keyword", "milestone",
  ]);
  assert.equal(observed.options.timeout, 8_000);
  assert.equal(observed.options.maxBuffer, 2 * 1024 * 1024);
  assert.equal(observed.options.env.HOME, value.root);
  assert.equal("DATABASE_URL" in observed.options.env, false);
  assert.equal("DINGTALK_SECRET" in observed.options.env, false);
  assert.equal(observed.args.some((item) => ["send", "update", "create", "delete"].includes(item)), false);
});

test("DWS project source fails closed for incomplete, mismatched or malformed reads", async (t) => {
  const value = await fixture(t);
  for (const stdout of [
    "not json",
    JSON.stringify({ complete: false, status: "success", content: { success: true, nodeId: value.nodeId, markdown: "x" } }),
    JSON.stringify({ complete: true, status: "success", content: { success: true, nodeId: "OTHERPROJECTDOCNODE123456789012", markdown: "x" } }),
    JSON.stringify({ complete: true, status: "success", content: { success: true, nodeId: value.nodeId, markdown: "" } }),
  ]) {
    await assert.rejects(fetchDwsProjectDocument({
      dwsPath: value.dwsPath,
      nodeId: value.nodeId,
      environment: { FOURSDAY_DWS_HOME: value.root },
      run: async () => ({ stdout }),
    }), /project_source_read_failed/u);
  }
  await assert.rejects(fetchDwsProjectDocument({
    dwsPath: value.dwsPath,
    nodeId: value.nodeId,
    environment: { FOURSDAY_DWS_HOME: value.root },
    run: async () => { throw new Error("private backend detail"); },
  }), (error) => error.message === "project_source_read_failed");
});

test("DWS project inspection returns bounded freshness and ancestry metadata", async (t) => {
  const value = await fixture(t);
  let observed;
  const result = await inspectDwsProjectNode({
    dwsPath: value.dwsPath,
    nodeId: value.nodeId,
    environment: { FOURSDAY_DWS_HOME: value.root, DINGTALK_SECRET: "must-not-leak" },
    run: async (command, args, options) => {
      observed = { command, args, options };
      return { stdout: JSON.stringify({
        complete: true,
        status: "success",
        ok: true,
        data: { document: {
          success: true,
          nodeId: value.nodeId,
          nodeType: "file",
          name: "Current PRD",
          workspaceId: "EXAMPLEWORKSPACE01",
          folderId: "EXAMPLEPROJECTFOLDER1234567890",
          createTime: 1_785_000_000_000,
          updateTime: 1_787_000_000_000,
        } },
      }) };
    },
  });
  assert.deepEqual(observed.args, [
    "doc", "+inspect", "--node", value.nodeId,
    "--format", "json", "--timeout", "8",
  ]);
  assert.equal(observed.options.timeout, 8_000);
  assert.equal("DINGTALK_SECRET" in observed.options.env, false);
  assert.equal(result.nodeId, value.nodeId);
  assert.equal(result.nodeType, "file");
  assert.equal(result.title, "Current PRD");
  assert.equal(result.workspaceId, "EXAMPLEWORKSPACE01");
  assert.equal(result.folderId, "EXAMPLEPROJECTFOLDER1234567890");
  assert.match(result.updatedAt, /^2026-/u);
});

test("DWS host failures and document failures remain distinct", async (t) => {
  const value = await fixture(t);
  const unavailable = new Error("spawn failed");
  unavailable.code = "ENOENT";
  await assert.rejects(inspectDwsProjectNode({
    dwsPath: value.dwsPath,
    nodeId: value.nodeId,
    environment: { FOURSDAY_DWS_HOME: value.root },
    run: async () => { throw unavailable; },
  }), (error) => error.message === "project_source_host_unavailable");
  await assert.rejects(inspectDwsProjectNode({
    dwsPath: value.dwsPath,
    nodeId: value.nodeId,
    environment: { FOURSDAY_DWS_HOME: value.root },
    run: async () => { throw new Error("private document error"); },
  }), (error) => error.message === "project_source_read_failed");
});
