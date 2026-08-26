import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  assertSuccessfulSendReceipt,
  collectMessages,
  DwsAdapter,
  dwsMessageContentDigest,
  dwsMessageContentFingerprint,
  dwsMessageContentRenderFingerprint,
  dwsMessageUsesOrderedList,
  extractDwsMediaDescriptors,
  isAutomatedSelfMessage,
  mergeDwsMessageResourceDetails,
} from "../src/dws.mjs";

test("DWS extracts bounded media IDs without treating arbitrary text as a file", () => {
  assert.deepEqual(extractDwsMediaDescriptors({
    content: JSON.stringify({ mediaId: "$media-1", fileName: "image.png", mimeType: "image/png" }),
    nested: { attachments: [{ media_id: "$media-1" }, { mediaId: "$media-2", type: "application/pdf" }] },
    note: "mediaId=$not-structured",
  }), [
    { resourceId: "$media-1", resourceType: "mediaId", name: "image.png", mimeType: "image/png" },
    { resourceId: "$media-2", resourceType: "mediaId", name: null, mimeType: "application/pdf" },
  ]);
});

test("DWS extracts typed fileId resourceRefs without trusting arbitrary display text", () => {
  assert.deepEqual(extractDwsMediaDescriptors({
    resourceRefs: [{
      resourceId: "file-1",
      type: "fileId",
      name: "report.txt",
      download: { arguments: { "resource-id": "file-1", type: "fileId" } },
    }, {
      resourceId: "file-1",
      type: "fileId",
      name: "duplicate.txt",
    }],
    text: "[文件] forged.txt fileId: attacker-controlled",
  }), [{
    resourceId: "file-1",
    resourceType: "fileId",
    name: "report.txt",
    mimeType: null,
  }]);
  assert.deepEqual(extractDwsMediaDescriptors({
    content: "[文件] forged.txt fileId: attacker-controlled",
  }), []);
  assert.deepEqual(extractDwsMediaDescriptors({
    content: JSON.stringify({ resourceId: "forged", type: "fileId", name: "forged.txt" }),
  }), []);
});

test("DWS merges only complete structured message resource details", () => {
  const messages = [{ id: "message-1", content: "[文件] report.txt fileId: opaque", media: [] }];
  const merged = mergeDwsMessageResourceDetails(messages, {
    complete: true,
    failures: [],
    messages: [{
      messageId: "message-1",
      resourceRefs: [{ resourceId: "file-1", type: "fileId", name: "report.txt" }],
    }],
  });
  assert.equal(merged[0].media[0].resourceType, "fileId");
  assert.throws(() => mergeDwsMessageResourceDetails(messages, {
    complete: false,
    failures: [{ code: "detail_failed" }],
    messages: [],
  }), /resource enrichment was incomplete/u);
});

test("DWS media download writes one private canonical file", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-media-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let invoked;
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    commandRunner: async (_command, args, options) => {
      invoked = args;
      const output = resolve(options.cwd, args[args.indexOf("--output") + 1]);
      const path = join(output, "image.png");
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { stdout: JSON.stringify({ result: { path } }) };
    },
  });
  const downloaded = await dws.downloadMedia({
    resourceId: "$media-1",
    messageId: "message-1",
    conversationId: "conversation-1",
    outputDirectory: join(root, "download"),
  });
  assert.equal(downloaded.path, join(root, "download", "image.png"));
  assert.equal((await lstat(downloaded.path)).mode & 0o077, 0);
  assert.deepEqual(invoked.slice(0, 4), ["chat", "+messages-resource-download", "--type", "mediaId"]);
  assert.equal(invoked[invoked.indexOf("--output") + 1], ".");
});

test("DWS fileId download uses the typed shortcut without message context", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-file-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let invocation;
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    commandRunner: async (_command, args, options) => {
      invocation = { args, cwd: options.cwd };
      const path = join(options.cwd, "report.txt");
      await writeFile(path, "verified file\n");
      return { stdout: JSON.stringify({ result: { path } }) };
    },
  });
  const downloaded = await dws.downloadMedia({
    resourceId: "file-1",
    resourceType: "fileId",
    outputDirectory: join(root, "download"),
  });
  assert.equal(await realpath(downloaded.path), join(root, "download", "report.txt"));
  assert.equal(invocation.cwd, join(root, "download"));
  assert.deepEqual(invocation.args.slice(0, 6), [
    "chat", "+messages-resource-download", "--type", "fileId", "--resource-id", "file-1",
  ]);
  assert.equal(invocation.args.includes("--message-id"), false);
  assert.equal(invocation.args.includes("--open-conversation-id"), false);
  await assert.rejects(dws.downloadMedia({
    resourceId: "file-1",
    resourceType: "unknown",
    outputDirectory: join(root, "invalid"),
  }), /resourceType is invalid/u);
});

test("DWS sender history enriches generated file hints and merges existing media", async () => {
  const calls = [];
  const timeouts = [];
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    commandRunner: async (_command, args, options) => {
      calls.push(args);
      timeouts.push(options.timeout);
      if (args.includes("list-by-sender")) {
        return { stdout: JSON.stringify({
          result: {
            messages: [{
              openMessageId: "message-1",
              openConversationId: "conversation-1",
              senderUserId: "trusted-user",
              senderName: "Owner",
              singleChat: true,
              createTime: "2026-08-25T13:54:39+08:00",
              content: "[文件] report.txt fileId: opaque 注意：如需下载使用dws drive download命令下载",
              mediaId: "media-1",
              fileName: "preview.png",
              mimeType: "image/png",
            }],
            hasMore: false,
          },
        }) };
      }
      assert.equal(args.includes("+messages-mget"), true);
      return { stdout: JSON.stringify({
        complete: true,
        failures: [],
        messages: [{
          messageId: "message-1",
          resourceRefs: [{ resourceId: "file-1", type: "fileId", name: "report.txt" }],
        }],
      }) };
    },
  });
  const messages = await dws.fetchBySenderAll({
    senderUserId: "trusted-user",
    start: new Date("2026-08-25T13:54:00+08:00"),
    end: new Date("2026-08-25T13:55:00+08:00"),
    timeoutMs: 12_000,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(timeouts, [12_000, 12_000]);
  assert.equal(calls[1][calls[1].indexOf("--msg-ids") + 1], "message-1");
  assert.deepEqual(messages[0].media, [
    {
      resourceId: "media-1",
      resourceType: "mediaId",
      name: "preview.png",
      mimeType: "image/png",
    },
    {
      resourceId: "file-1",
      resourceType: "fileId",
      name: "report.txt",
      mimeType: null,
    },
  ]);
});

test("DWS 解析会话嵌套消息结构", () => {
  const messages = collectMessages(
    {
      result: {
        conversationMessagesList: [
          {
            openConversationId: "c1",
            messages: [
              {
                openMessageId: "m1",
                sender: "测试用户",
                createTime: "2026-07-31T10:00:00Z",
                content: "你好",
              },
            ],
          },
        ],
      },
    },
    "u1",
  );
  assert.deepEqual(
    {
      id: messages[0].id,
      senderUserId: messages[0].senderUserId,
      conversationId: messages[0].conversationId,
      content: messages[0].content,
    },
    { id: "m1", senderUserId: "u1", conversationId: "c1", content: "你好" },
  );
});


test("发送回执必须明确成功，失败或空回执不能冒充已发送", () => {
  assert.deepEqual(
    assertSuccessfulSendReceipt({ result: { sendStatus: "SUCCESS" } }),
    { result: { sendStatus: "SUCCESS" } },
  );
  assert.deepEqual(assertSuccessfulSendReceipt({ success: true }), {
    success: true,
  });
  assert.throws(
    () => assertSuccessfulSendReceipt({ success: false }),
    (error) => error.code === "dws_send_failed",
  );
  assert.throws(
    () => assertSuccessfulSendReceipt({ result: { sendStatus: "FAILED" } }),
    (error) => error.code === "dws_send_failed",
  );
  assert.throws(
    () => assertSuccessfulSendReceipt({ result: [] }),
    (error) => error.code === "dws_send_receipt_unknown",
  );
  assert.throws(
    () => assertSuccessfulSendReceipt({ meta: { status: "SUCCESS" }, result: {} }),
    (error) => error.code === "dws_send_receipt_unknown",
  );
});

test("DWS 子进程只接收工具运行白名单环境", async () => {
  let invocation;
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    environment: {
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      LANG: "zh_CN.UTF-8",
      SSL_CERT_FILE: "/safe/cert.pem",
      HTTPS_PROXY: "https://proxy.example",
      FOURSDAY_DATABASE_URL: "postgresql://secret",
      FOURSDAY_ADMIN_TOKEN: "admin-secret",
      FOURSDAY_DATA_KEY: "data-secret",
      ALERT_WEBHOOK_URL: "https://secret.example/hook",
      DINGTALK_ACCESS_TOKEN: "dingtalk-secret",
      UNRELATED_SECRET: "extra-secret",
    },
    commandRunner: async (...args) => {
      invocation = args;
      return { stdout: "{}" };
    },
  });

  await dws.run(["chat", "message", "list-direct"], {
    timeout: 1_234,
    env: { DATABASE_URL: "caller-override", INJECTED_SECRET: "injected" },
  });

  const childEnvironment = invocation[2].env;
  assert.equal(invocation[2].timeout, 1_234);
  assert.equal(childEnvironment.HOME, "/safe/home");
  assert.equal(childEnvironment.TMPDIR, "/safe/tmp");
  assert.equal(childEnvironment.LANG, "zh_CN.UTF-8");
  assert.equal(childEnvironment.SSL_CERT_FILE, "/safe/cert.pem");
  assert.equal(childEnvironment.HTTPS_PROXY, "https://proxy.example");
  assert.ok(childEnvironment.PATH.startsWith("/safe/bin:"));
  for (const name of [
    "FOURSDAY_DATABASE_URL",
    "FOURSDAY_ADMIN_TOKEN",
    "FOURSDAY_DATA_KEY",
    "ALERT_WEBHOOK_URL",
    "DINGTALK_ACCESS_TOKEN",
    "UNRELATED_SECRET",
    "INJECTED_SECRET",
  ]) {
    assert.equal(Object.hasOwn(childEnvironment, name), false);
  }
  const childValues = new Set(Object.values(childEnvironment));
  for (const secret of [
    "postgresql://secret",
    "admin-secret",
    "data-secret",
    "https://secret.example/hook",
    "dingtalk-secret",
    "extra-secret",
    "caller-override",
    "injected",
  ]) {
    assert.equal(childValues.has(secret), false);
  }
});

test("DWS rendered Markdown keeps one automation fingerprint", () => {
  const original = "截至最新可用回读：\n\n- 版本：`v1`\n- 模式：`active`\n- 发送：`true`";
  const rendered = "截至最新可用回读：  \n- 版本：**v1**- 模式：**active**- 发送：**true**";
  assert.notEqual(dwsMessageContentDigest(original), dwsMessageContentDigest(rendered));
  assert.equal(dwsMessageContentFingerprint(original), dwsMessageContentFingerprint(rendered));
  assert.equal(isAutomatedSelfMessage({
    id: "rendered-message",
    conversationId: "self-conversation",
    createTime: "2026-08-25T11:16:01+08:00",
    content: rendered,
    raw: {},
  }, [{
    conversationId: "self-conversation",
    startedAt: "2026-08-25T11:16:00+08:00",
    contentFingerprint: dwsMessageContentFingerprint(original),
  }]), true);
});

test("DWS stripped local-link paths keep one automation fingerprint", () => {
  const original = [
    "1. 消息碎片口径基本一致：",
    "参考 ([产品需求文档](/Users/example/Documents/Foursday/docs/产品需求文档.md:526))，",
    "2. 并对照 ([技术设计文档](file:///Users/example/Documents/Foursday/docs/技术设计文档.md:234))。",
  ].join("\n");
  const rendered = [
    "1. 消息碎片口径基本一致：",
    "参考 ([产品需求文档](:526))，",
    "1. 并对照 ([技术设计文档](:234))。",
  ].join("\n");
  assert.notEqual(dwsMessageContentDigest(original), dwsMessageContentDigest(rendered));
  assert.notEqual(dwsMessageContentFingerprint(original), dwsMessageContentFingerprint(rendered));
  assert.equal(
    dwsMessageContentRenderFingerprint(original),
    dwsMessageContentRenderFingerprint(rendered),
  );
  assert.equal(dwsMessageUsesOrderedList(original), true);
  assert.equal(isAutomatedSelfMessage({
    id: "rendered-local-link-message",
    conversationId: "self-conversation",
    createTime: "2026-08-25T23:55:54+08:00",
    content: rendered,
    raw: {},
  }, [{
    conversationId: "self-conversation",
    startedAt: "2026-08-25T23:55:53+08:00",
    status: "unknown",
    fingerprintVersion: 2,
    orderedListFingerprint: true,
    contentFingerprint: dwsMessageContentFingerprint(original),
    contentRenderFingerprint: dwsMessageContentRenderFingerprint(original),
  }]), true);

  assert.notEqual(
    dwsMessageContentRenderFingerprint(original),
    dwsMessageContentRenderFingerprint(rendered.replace("产品需求文档", "另一份文档")),
  );
});

test("DWS long ordered lists survive collapsed line boundaries without weakening business numbers", () => {
  const original = [
    "1. 当前进度已经核对。",
    "2. 处理 12,345 条合成记录。",
    "3. 冻结一版数据合同。",
  ].join("\n");
  const rendered = "1. 当前进度已经核对。2.处理 12,345 条合成记录。3.冻结一版数据合同。";
  assert.equal(dwsMessageUsesOrderedList(original), true);
  assert.equal(dwsMessageContentFingerprint(original), dwsMessageContentFingerprint(rendered));
  assert.equal(
    dwsMessageContentRenderFingerprint(original),
    dwsMessageContentRenderFingerprint(rendered),
  );
  assert.notEqual(
    dwsMessageContentRenderFingerprint("共处理 2. 个业务批次"),
    dwsMessageContentRenderFingerprint("共处理 3. 个业务批次"),
  );
  assert.notEqual(
    dwsMessageContentRenderFingerprint(original),
    dwsMessageContentRenderFingerprint(rendered.replace("12,345", "12,346")),
  );
});

test("DWS dual fingerprints stay bounded for long replies", () => {
  const value = Array.from({ length: 5_000 }, (_item, index) =>
    `${index + 1}. 合成长文本第 ${index + 10_000} 条。`
  ).join("\n");
  const startedAt = performance.now();
  assert.match(dwsMessageContentFingerprint(value), /^[a-f0-9]{64}$/u);
  assert.match(dwsMessageContentRenderFingerprint(value), /^[a-f0-9]{64}$/u);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `fingerprinting took ${elapsedMs.toFixed(1)}ms`);
});

test("DWS self-message matching fingerprints one long message across a full ledger", () => {
  const content = Array.from({ length: 1_000 }, (_item, index) =>
    `${index + 1}. 合成长回复第 ${index + 20_000} 条。`
  ).join("\n");
  const evidence = Array.from({ length: 1_000 }, (_item, index) => ({
    conversationId: "self-conversation",
    startedAt: "2026-08-26T09:39:49+08:00",
    fingerprintVersion: 2,
    orderedListFingerprint: true,
    contentFingerprint: `${String(index).padStart(64, "0")}`.slice(-64),
    contentRenderFingerprint: index === 999
      ? dwsMessageContentRenderFingerprint(content)
      : `${String(index + 1).padStart(64, "0")}`.slice(-64),
  }));
  const startedAt = performance.now();
  assert.equal(isAutomatedSelfMessage({
    id: "long-rendered-message",
    conversationId: "self-conversation",
    createTime: "2026-08-26T09:40:01+08:00",
    content,
    raw: {},
  }, evidence), true);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `ledger matching took ${elapsedMs.toFixed(1)}ms`);
});

test("legacy ordered-list fingerprints still identify already-sent rendered messages", () => {
  const original = "1. 第一项。\n2. 第二项。";
  const rendered = "1. 第一项。2.第二项。";
  assert.equal(isAutomatedSelfMessage({
    id: "legacy-rendered-message",
    conversationId: "self-conversation",
    createTime: "2026-08-26T09:40:01+08:00",
    content: rendered,
    raw: {},
  }, [{
    conversationId: "self-conversation",
    startedAt: "2026-08-26T09:39:49+08:00",
    status: "unknown",
    contentFingerprint: dwsMessageContentRenderFingerprint(original),
  }]), true);
});

test("DWS CLI calls are serialized so the local data lock cannot race", async () => {
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    commandRunner: async (_command, args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(args[0]);
      await new Promise((accept) => setTimeout(accept, 10));
      active -= 1;
      return { stdout: "{}" };
    },
  });
  await Promise.all([
    dws.run(["first"]),
    dws.run(["second"]),
    dws.run(["third"]),
  ]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("separate DWS adapter instances share the same private command lock", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-adapter-lock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "dws-command.lock");
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const commandRunner = async (_command, args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`${args[0]}:start`);
    await new Promise((accept) => setTimeout(accept, 20));
    order.push(`${args[0]}:end`);
    active -= 1;
    return { stdout: "{}" };
  };
  const options = {
    dwsPath: "/safe/bin/dws",
    commandRunner,
    environment: { HOME: root, DWS_PERSONAL_COMMAND_LOCK: lock },
  };
  const first = new DwsAdapter(options);
  const second = new DwsAdapter(options);
  await Promise.all([first.run(["first"]), second.run(["second"])]);
  assert.equal(maximumActive, 1);
  assert.equal(
    JSON.stringify(order) === JSON.stringify(["first:start", "first:end", "second:start", "second:end"]) ||
    JSON.stringify(order) === JSON.stringify(["second:start", "second:end", "first:start", "first:end"]),
    true,
  );
});

test("a failed DWS CLI call does not block the following queued call", async () => {
  let calls = 0;
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    commandRunner: async () => {
      calls += 1;
      if (calls === 1) throw new Error("data lock busy");
      return { stdout: JSON.stringify({ success: true }) };
    },
  });
  await assert.rejects(dws.run(["first"]), /data lock busy/u);
  assert.deepEqual(await dws.run(["second"]), { success: true });
});

test("enterprise direct scan admits only contact-verified current-organization senders", async () => {
  const calls = [];
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    commandRunner: async (_command, args) => {
      calls.push(args);
      if (args.includes("search-advanced")) return { stdout: JSON.stringify({
        result: {
          hasMore: false,
          failures: [],
          conversationMessagesList: [{
            singleChat: true,
            openConversationId: "direct-employee",
            messages: [{
              openMessageId: "message-employee-1",
              senderUserId: "employee-user",
              senderName: "Employee",
              createTime: "2026-08-26T14:00:01+08:00",
              content: "请核对项目进度",
              isSelf: false,
            }, {
              openMessageId: "message-employee-2",
              senderUserId: "employee-user",
              senderName: "Employee",
              createTime: "2026-08-26T14:00:02+08:00",
              content: "补充一条",
              isSelf: false,
            }],
          }, {
            singleChat: true,
            openConversationId: "direct-transient-unverified",
            messages: [{
              openMessageId: "message-transient-unverified",
              senderUserId: "transient-user",
              senderName: "Transient",
              createTime: "2026-08-26T14:00:04+08:00",
              content: "身份服务临时失败",
              isSelf: false,
            }],
          }, {
            singleChat: true,
            openConversationId: "direct-external",
            messages: [{
              openMessageId: "message-external",
              senderUserId: "external-user",
              senderName: "External",
              createTime: "2026-08-26T14:00:03+08:00",
              content: "外部联系人消息",
              isSelf: false,
            }],
          }, {
            singleChat: false,
            openConversationId: "group-1",
            messages: [{
              openMessageId: "message-group",
              senderUserId: "employee-user",
              createTime: "2026-08-26T14:00:04+08:00",
              content: "群消息",
            }],
          }, {
            singleChat: true,
            openConversationId: "direct-policy-unverified",
            messages: [{
              openMessageId: "message-policy-unverified",
              senderUserId: "policy-user",
              createTime: "2026-08-26T14:00:04+08:00",
              content: "无显示名且组织接口拒绝",
              isSelf: false,
            }],
          }, {
            singleChat: true,
            openConversationId: "direct-owner-outbound",
            messages: [{
              openMessageId: "message-owner-outbound",
              senderUserId: "owner-user",
              senderName: "Owner",
              createTime: "2026-08-26T14:00:05+08:00",
              content: "Owner发出的消息",
              isSelf: false,
            }],
          }],
        },
      }) };
      const id = args[args.indexOf("--ids") + 1];
      if (args.includes("contact") && id === "employee-user") {
        const denied = new Error("organization contact policy denied");
        denied.code = 4;
        throw denied;
      }
      if (args.includes("contact") && id === "policy-user") {
        const denied = new Error("organization contact policy denied");
        denied.code = 4;
        denied.stderr = '{"code":"PAT_ORG_POLICY_DENIED","data":{"policy":"OPEN_SOURCE_ORG_SCOPE_FORBIDDEN"}}';
        throw denied;
      }
      if (args.includes("contact") && id === "transient-user") {
        throw new Error("temporary contact transport failure");
      }
      if (args.includes("aisearch") && args.includes("Transient")) {
        throw new Error("temporary identity search failure");
      }
      if (args.includes("aisearch")) return { stdout: JSON.stringify({
        result: [{
          orgEmployeeModel: {
            userId: "employee-user",
            openDingTalkId: "open-employee",
          },
        }],
      }) };
      return { stdout: JSON.stringify({
        result: [],
      }) };
    },
  });
  const messages = await dws.fetchEnterpriseDirect({
    start: new Date("2026-08-26T14:00:00+08:00"),
    end: new Date("2026-08-26T14:01:00+08:00"),
    selfUserId: "owner-user",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages.every((message) => message.senderUserId === "employee-user"), true);
  assert.equal(messages.every((message) => message.senderOpenDingTalkId === "open-employee"), true);
  assert.equal(messages.every((message) => message.enterpriseVerified === true), true);
  assert.equal(messages.every((message) => message.singleChat === true), true);
  const search = calls.find((args) => args.includes("search-advanced"));
  assert.ok(search.includes("--start"));
  assert.ok(search.includes("--end"));
  assert.ok(search.includes("--page-all"));
  assert.equal(search.includes("--user"), false);
  assert.equal(search.includes("--query"), false);
  assert.equal(calls.filter((args) => args.includes("employee-user")).length, 1);
  assert.equal(calls.filter((args) => args.includes("external-user")).length, 1);
  assert.equal(calls.filter((args) => args.includes("owner-user")).length, 0);
  assert.equal(calls.filter((args) => args.includes("policy-user")).length, 1);
  assert.equal(calls.filter((args) => args.includes("aisearch")).length, 2);
});

test("enterprise direct scan retries one incomplete projection before failing closed", async () => {
  let attempts = 0;
  const dws = new DwsAdapter({ dwsPath: "/safe/bin/dws" });
  dws.run = async () => {
    attempts += 1;
    return attempts === 1
      ? { result: { complete: false, hasMore: true, failures: [{ code: "projection_pending" }] } }
      : { result: { complete: true, hasMore: false, failures: [], conversationMessagesList: [] } };
  };
  assert.deepEqual(await dws.fetchEnterpriseDirect({
    start: new Date("2026-08-26T14:00:00+08:00"),
    end: new Date("2026-08-26T14:01:00+08:00"),
  }), []);
  assert.equal(attempts, 2);
});

test("enterprise direct scan reports the bounded incompleteness reason", async () => {
  let attempts = 0;
  const dws = new DwsAdapter({ dwsPath: "/safe/bin/dws" });
  dws.run = async () => {
    attempts += 1;
    return { result: { complete: false, hasMore: false, failures: [{ code: "source_pending" }] } };
  };
  await assert.rejects(dws.fetchEnterpriseDirect({
    start: new Date("2026-08-26T14:00:00+08:00"),
    end: new Date("2026-08-26T14:01:00+08:00"),
  }), (error) => error.code === "dws_enterprise_scan_incomplete_failures");
  assert.equal(attempts, 2);
});

test("enterprise direct scan splits broad history into complete two-minute slices", async () => {
  const calls = [];
  const dws = new DwsAdapter({ dwsPath: "/safe/bin/dws" });
  dws.run = async (args) => {
    calls.push(args);
    return {
      result: {
        complete: true,
        hasMore: false,
        failures: [],
        conversationMessagesList: [{
          singleChat: true,
          openConversationId: "conversation",
          messages: [{
            openMessageId: "same-message",
            senderUserId: "enterprise-user",
            senderName: "Employee",
            createTime: "2026-08-26T14:01:00+08:00",
            content: "bounded evidence",
            isSelf: false,
          }],
        }],
      },
    };
  };
  dws.verifyEnterpriseUser = async () => ({
    userId: "enterprise-user",
    openDingTalkId: "open-enterprise",
  });
  dws.enrichMessageResources = async (rows) => rows;
  const rows = await dws.fetchEnterpriseDirect({
    start: new Date("2026-08-26T14:00:00+08:00"),
    end: new Date("2026-08-26T14:10:00+08:00"),
  });
  assert.equal(calls.length, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "same-message");
});

test("DWS personal event wake waits for ready and forwards only valid event signals", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", 0, signal));
    return true;
  };
  let invocation;
  const events = [];
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    environment: { HOME: "/safe/home", FOURSDAY_DATA_KEY: "secret" },
    processSpawner: (...args) => { invocation = args; return child; },
  });
  const wake = dws.createPersonalEventWake({
    onEvent: (event) => events.push(event),
    readyTimeoutMs: 1_000,
  });
  child.stdout.write(`${JSON.stringify({ event_id: "too-early" })}\n`);
  child.stderr.write("[event] ready event_key=user_im_message_receive_o2o_all bus_pid=1 subscribe_id=test\n");
  await wake.ready;
  child.stdout.write("not-json\n");
  child.stdout.write(`${JSON.stringify({ event_id: "event-1", type: "message" })}\n`);
  child.stdout.write(`${JSON.stringify({ event_type: "message", data: { event_id: "event-2" } })}\n`);
  await new Promise((accept) => setImmediate(accept));
  assert.deepEqual(events, [
    { eventId: "event-1", type: "message" },
    { eventId: "event-2", type: "message" },
  ]);
  assert.deepEqual(invocation[1], [
    "event", "+listen-im", "--kind", "all-direct",
    "--events", "message", "--format", "ndjson",
  ]);
  assert.equal(Object.hasOwn(invocation[2].env, "FOURSDAY_DATA_KEY"), false);
  await wake.stop();
});

test("人工回复按当前账号发送记录和会话匹配", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.fetchBySenderAll = async ({ senderUserId }) => [
    {
      createTime: "2026-07-31T10:01:00Z",
      isSelf: false,
      senderUserId,
      conversationId: "c1",
      raw: { sender: "Ray" },
    },
  ];
  assert.deepEqual(
    await dws.hasManualReply({
      conversationId: "c1",
      selfUserId: "self",
      after: "2026-07-31T10:00:00Z",
    }),
    {
      known: true,
      replied: true,
      message: {
        id: null,
        content: "",
        createTime: "2026-07-31T10:01:00Z",
      },
    },
  );
});

test("人工回复不会跨会话误取消", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.fetchBySenderAll = async () => [
    {
      createTime: "2026-07-31T10:01:00Z",
      conversationId: "other-conversation",
    },
  ];
  assert.deepEqual(
    await dws.hasManualReply({
      conversationId: "c1",
      selfUserId: "self",
      after: "2026-07-31T10:00:00Z",
    }),
    { known: true, replied: false, message: null },
  );
});

test("人工回复查询把发送边界的短超时传给DWS读取", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let observed = null;
  dws.fetchBySenderAll = async (input) => {
    observed = input;
    return [];
  };
  assert.deepEqual(await dws.hasManualReply({
    conversationId: "c1",
    selfUserId: "self",
    after: "2026-07-31T10:00:00Z",
    timeoutMs: 12_000,
  }), { known: true, replied: false, message: null });
  assert.equal(observed.timeoutMs, 12_000);
});

test("AI 标签、发送标识或同次发送内容不会冒充人工回复", () => {
  const evidence = [{
    taskId: "reply-1",
    idempotencyKey: "reply-1",
    conversationId: "c1",
    content: "请补充上线日期。",
    startedAt: "2026-07-31T10:00:00Z",
    receipt: { result: { openTaskId: "task-marker-1" } },
  }];
  assert.equal(isAutomatedSelfMessage({
    id: "m1",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "任意内容",
    raw: { aiTag: true },
  }, []), true);
  assert.equal(isAutomatedSelfMessage({
    id: "m2",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "请补充上线日期。",
    raw: {},
  }, evidence), true);
  assert.equal(isAutomatedSelfMessage({
    id: "m3",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "我来接手处理。",
    raw: {},
  }, evidence), false);
  assert.equal(isAutomatedSelfMessage({
    id: "m4",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "第一行 第二行",
    raw: {},
  }, [{
    ...evidence[0],
    content: "第一行\n第二行",
  }]), true);
  assert.equal(isAutomatedSelfMessage({
    id: "m5",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "第一行 第二行",
    raw: {},
  }, [{
    conversationId: "c1",
    startedAt: "2026-07-31T10:00:00Z",
    contentDigest: dwsMessageContentDigest("第一行\n第二行"),
  }]), true);
});

test("发送者分页只保留单聊消息", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let calls = 0;
  dws.run = async (args) => {
    if (args[0] === "contact") {
      return { result: [{ userId: "u1", openDingTalkId: "open-u1" }] };
    }
    calls += 1;
    return calls === 1
      ? {
          result: {
            hasMore: true,
            nextCursor: "next",
            conversationMessagesList: [
              {
                singleChat: false,
                openConversationId: "group",
                messages: [{ openMessageId: "g1", sender: "测试用户", senderOpenDingTalkId: "open-u1", createTime: "1" }],
              },
              {
                singleChat: true,
                openConversationId: "direct",
                messages: [{ openMessageId: "d1", sender: "测试用户", senderOpenDingTalkId: "open-u1", createTime: "2" }],
              },
            ],
          },
        }
      : {
          result: {
            hasMore: false,
            conversationMessagesList: [
              {
                singleChat: true,
                openConversationId: "direct",
                messages: [{ openMessageId: "d2", sender: "测试用户", senderOpenDingTalkId: "open-u1", createTime: "3" }],
              },
            ],
          },
        };
  };
  const messages = await dws.fetchBySender({
    senderUserId: "u1",
    start: new Date(),
    end: new Date(),
  });
  assert.deepEqual(
    messages.map((message) => message.id),
    ["d1", "d2"],
  );
});

test("响应已含精确发送者身份时不依赖显示名或通讯录查询", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => {
    assert.notEqual(args[0], "contact");
    return {
      result: {
        hasMore: false,
        conversationMessagesList: [{
          singleChat: true,
          openConversationId: "direct",
          messages: [{
            openMessageId: "d-stable",
            senderUserId: "u-stable",
            createTime: "2026-07-31 10:00:00",
          }],
        }],
      },
    };
  };
  const messages = await dws.fetchBySender({
    senderUserId: "u-stable",
    start: new Date("2026-07-31T00:00:00Z"),
    end: new Date("2026-07-31T12:00:00Z"),
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderUserId, "u-stable");
});

test("发送者查询拒绝响应中不匹配的身份", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => args[0] === "contact"
    ? { result: [{ userId: "allowlisted-user", openDingTalkId: "open-allowlisted" }] }
    : ({ result: {
      hasMore: false,
      conversationMessagesList: [{
        singleChat: true,
        openConversationId: "direct",
        messages: [{
          openMessageId: "unexpected-message",
          sender: "异常用户",
          senderUserId: "unexpected-user",
          senderOpenDingTalkId: "open-attacker",
          createTime: "2026-07-31 10:00:00",
        }],
      }],
    } });

  await assert.rejects(
    dws.fetchBySender({
      senderUserId: "allowlisted-user",
      start: new Date("2026-07-31T00:00:00Z"),
      end: new Date("2026-07-31T12:00:00Z"),
    }),
    (error) => error.code === "dws_sender_identity_mismatch",
  );
});

test("通讯录详情受策略限制时经AI搜问精确绑定双身份", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => {
    if (args[2] === "get") throw new Error("PAT_ORG_POLICY_DENIED");
    assert.deepEqual(args, [
      "aisearch", "person", "--keyword", "测试用户", "--dimension", "name",
    ]);
    return {
      result: [
        { userId: "other-user", openDingTalkId: "open-other" },
        { userId: "staff-user", openDingTalkId: "open-staff" },
      ],
    };
  };
  assert.equal(
    await dws.resolveUserOpenDingTalkId("staff-user", "测试用户"),
    "open-staff",
  );
});

test("群聊监听只保留白名单群中的 @我 消息", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => {
    assert.ok(args.includes("--at-me"));
    assert.equal(args[args.indexOf("--conversation-ids") + 1], "group-1");
    return {
      result: {
        hasMore: false,
        conversationMessagesList: [
          {
            singleChat: false,
            openConversationId: "group-1",
            messages: [
              {
                openMessageId: "g1",
                createTime: "2026-07-31 10:00:00",
                sender: "测试用户",
                senderOpenDingTalkId: "open-user-1",
                content: "@负责人 帮忙看下",
              },
            ],
          },
          {
            singleChat: false,
            openConversationId: "other-group",
            messages: [
              {
                openMessageId: "g2",
                createTime: "2026-07-31 10:01:00",
                senderOpenDingTalkId: "open-user-2",
              },
            ],
          },
        ],
      },
    };
  };
  const messages = await dws.fetchGroupMentions({
    groupIds: ["group-1"],
    start: new Date("2026-07-31T00:00:00Z"),
    end: new Date("2026-07-31T12:00:00Z"),
  });
  assert.deepEqual(
    messages.map(({ id, senderUserId, conversationId }) => ({
      id,
      senderUserId,
      conversationId,
    })),
    [
      {
        id: "g1",
        senderUserId: "open-user-1",
        conversationId: "group-1",
      },
    ],
  );
});

test("私聊抓取优先保留配置的通讯录账号", () => {
  const [message] = collectMessages(
    {
      result: {
        conversationMessagesList: [
          {
            singleChat: true,
            openConversationId: "direct-1",
            messages: [
              {
                openMessageId: "d1",
                createTime: "2026-07-31 10:00:00",
                sender: "测试用户",
                senderOpenDingTalkId: "open-user-1",
              },
            ],
          },
        ],
      },
    },
    "staff-user-1",
  );
  assert.equal(message.senderUserId, "staff-user-1");
});

test("已有开放账号任务使用开放账号参数拉取私聊", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return { result: { conversationMessagesList: [] } };
  };
  await dws.fetchDirect({ userId: "DTestOpenId123" });
  assert.ok(args.includes("--open-dingtalk-id"));
  assert.ok(!args.includes("--user"));
  assert.equal(args[args.indexOf("--forward") + 1], "true");
});

test("非 DT 前缀的开放账号依靠显式身份类型拉取私聊", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return { result: { conversationMessagesList: [] } };
  };
  await dws.fetchDirect({
    userId: "opaque-open-id",
    identityKind: "open_dingtalk_id",
  });
  assert.ok(args.includes("--open-dingtalk-id"));
  assert.ok(!args.includes("--user"));
});

test("私聊上下文从过去向现在读取并只保留截止时间前最后若干条", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return {
      result: {
        conversationMessagesList: [{
          singleChat: true,
          openConversationId: "direct-1",
          messages: [
            { openMessageId: "too-old", createTime: "2026-08-17T01:59:00.000Z" },
            { openMessageId: "m1", createTime: "2026-08-17T03:30:00.000Z" },
            { openMessageId: "m2", createTime: "2026-08-17T03:59:00.000Z" },
            { openMessageId: "m3", createTime: "2026-08-17T04:00:00.000Z" },
            { openMessageId: "future", createTime: "2026-08-17T04:00:02.000Z" },
          ],
        }],
      },
    };
  };
  const messages = await dws.fetchDirect({
    userId: "staff-user-1",
    before: new Date("2026-08-17T04:00:00.000Z"),
    lookbackMs: 2 * 60 * 60 * 1_000,
    limit: 2,
  });
  assert.equal(args[args.indexOf("--time") + 1], "2026-08-17 10:00:00");
  assert.equal(args[args.indexOf("--forward") + 1], "true");
  assert.equal(args[args.indexOf("--limit") + 1], "8");
  assert.deepEqual(messages.map((message) => message.id), ["m2", "m3"]);
});

test("发送回读可以为私聊查询设置短超时", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let observedTimeout = null;
  dws.run = async (_args, options) => {
    observedTimeout = options.timeout;
    return { result: { conversationMessagesList: [] } };
  };
  assert.deepEqual(await dws.fetchDirect({
    userId: "owner-user",
    before: new Date("2026-08-25T10:00:00Z"),
    limit: 10,
    lookbackMs: 60_000,
    timeoutMs: 10_000,
  }), []);
  assert.equal(observedTimeout, 10_000);
});

test("本人私聊文件通过消息详情富化为fileId附件", async () => {
  const calls = [];
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (input) => {
    calls.push(input);
    if (input.includes("list-direct")) {
      return {
        result: {
          conversationMessagesList: [{
            singleChat: true,
            openConversationId: "self-conversation",
            messages: [{
              openMessageId: "self-file",
              createTime: "2026-08-25T14:45:35+08:00",
              content: "[文件] report.txt fileId: opaque 注意：如需下载使用dws drive download命令下载",
            }],
          }],
        },
      };
    }
    assert.equal(input.includes("+messages-mget"), true);
    return {
      complete: true,
      failures: [],
      messages: [{
        messageId: "self-file",
        resourceRefs: [{ resourceId: "file-1", type: "fileId", name: "report.txt" }],
      }],
    };
  };
  const messages = await dws.fetchDirect({
    userId: "owner-user",
    identityKind: "user_id",
    before: new Date("2026-08-25T14:46:00+08:00"),
    lookbackMs: 60_000,
    limit: 10,
  });
  assert.equal(calls.length, 2);
  assert.equal(messages[0].media[0].resourceType, "fileId");
  assert.equal(messages[0].media[0].name, "report.txt");
});

test("已有开放账号任务使用开放账号参数发送私聊", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return { success: true };
  };
  await dws.sendText({
    userId: "DTestOpenId123",
    text: "收到",
    idempotencyKey: "task-1",
  });
  assert.ok(args.includes("--open-dingtalk-id"));
  assert.ok(!args.includes("--user"));
});

test("非 DT 前缀的开放账号依靠显式身份类型发送私聊", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return { success: true };
  };
  await dws.sendText({
    userId: "opaque-open-id",
    identityKind: "open_dingtalk_id",
    text: "收到",
    idempotencyKey: "task-explicit-open-id",
  });
  assert.ok(args.includes("--open-dingtalk-id"));
  assert.ok(!args.includes("--user"));
});
