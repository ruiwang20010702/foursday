import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FoursdayThreadBindingStore,
  foursdayPermissionVersion,
} from "../src/foursday-thread-bindings.mjs";

const context = (workspace, overrides = {}) => ({
  hermesSessionHash: "a".repeat(64),
  sourceSessionHash: "b".repeat(64),
  sourcePrincipalHash: "c".repeat(64),
  projectId: "project",
  workspace,
  ownerRevision: 0,
  sendGeneration: 0,
  ...overrides,
});

test("thread bindings persist exact private session and workspace scope", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-thread-bindings-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FoursdayThreadBindingStore({ root: join(root, "bindings") }).open();
  const permissionVersion = foursdayPermissionVersion({
    allowedRoots: new Set([root]),
    developerInstructions: "trusted",
  });
  const written = await store.bind(context(root), permissionVersion, "thread-1");
  const loaded = await store.get(context(root), permissionVersion);
  assert.equal(loaded.codexThreadId, "thread-1");
  assert.deepEqual(loaded.forkThreadIds, []);
  assert.equal(loaded.key, written.key);
  assert.equal((await lstat(join(root, "bindings"))).mode & 0o077, 0);
  const files = await import("node:fs/promises").then(({ readdir }) => readdir(join(root, "bindings")));
  assert.equal(files.length, 2);
  const bindingFile = files.find((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  const serialized = await readFile(join(root, "bindings", bindingFile), "utf8");
  assert.doesNotMatch(serialized, /trusted-user|staff-id/u);
});

test("thread forks stay inside the bound task and survive restart", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-thread-forks-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bindingRoot = join(root, "bindings");
  const version = foursdayPermissionVersion({
    allowedRoots: new Set([root]),
    developerInstructions: "trusted",
  });
  const first = await new FoursdayThreadBindingStore({ root: bindingRoot }).open();
  await first.bind(context(root), version, "thread-parent");
  await first.addFork(context(root), version, "thread-parent", "thread-child");
  await first.addFork(context(root), version, "thread-child", "thread-grandchild");

  const reopened = await new FoursdayThreadBindingStore({ root: bindingRoot }).open();
  const loaded = await reopened.get(context(root), version);
  assert.deepEqual(loaded.forkThreadIds, ["thread-child", "thread-grandchild"]);
  await assert.rejects(
    reopened.addFork(context(root), version, "foreign", "thread-other"),
    /parent is not bound/u,
  );
});

test("thread binding rejects conflicting creators and stale intervention revisions", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-thread-conflict-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FoursdayThreadBindingStore({ root: join(root, "bindings") }).open();
  const version = foursdayPermissionVersion({ allowedRoots: new Set([root]), developerInstructions: "v1" });
  await store.bind(context(root, { ownerRevision: 2, sendGeneration: 3 }), version, "thread-1");
  await assert.rejects(
    store.bind(context(root, { ownerRevision: 2, sendGeneration: 3 }), version, "thread-2"),
    /binding conflict/u,
  );
  await assert.rejects(
    store.bind(context(root, { ownerRevision: 1, sendGeneration: 3 }), version, "thread-1"),
    /revision is stale/u,
  );
});

test("concurrent fork registration is serialized without losing children", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-thread-concurrent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bindingRoot = join(root, "bindings");
  const version = foursdayPermissionVersion({ allowedRoots: new Set([root]), developerInstructions: "v1" });
  const first = await new FoursdayThreadBindingStore({ root: bindingRoot }).open();
  const second = await new FoursdayThreadBindingStore({ root: bindingRoot }).open();
  await first.bind(context(root), version, "thread-parent");
  await Promise.all([
    first.addFork(context(root), version, "thread-parent", "thread-a"),
    second.addFork(context(root), version, "thread-parent", "thread-b"),
  ]);
  const loaded = await first.get(context(root), version);
  assert.deepEqual(loaded.forkThreadIds, ["thread-a", "thread-b"]);
});

test("thread binding does not cross principal or permission scope", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-thread-scope-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FoursdayThreadBindingStore({ root: join(root, "bindings") }).open();
  const version = foursdayPermissionVersion({ allowedRoots: new Set([root]), developerInstructions: "v1" });
  await store.bind(context(root), version, "thread-1");
  assert.equal(await store.get(context(root, { sourcePrincipalHash: "d".repeat(64) }), version), null);
  await assert.rejects(
    store.bind(
      context(root, { sourcePrincipalHash: "d".repeat(64) }),
      version,
      "thread-1",
    ),
    /belongs to another scope/u,
  );
  const nextVersion = foursdayPermissionVersion({ allowedRoots: new Set([root]), developerInstructions: "v2" });
  assert.equal(await store.get(context(root), nextVersion), null);
});

test("thread binding root rejects symlinks", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-thread-symlink-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { mode: 0o700 }));
  const link = join(root, "link");
  await symlink(target, link);
  await assert.rejects(new FoursdayThreadBindingStore({ root: link }).open(), /unsafe/u);
});
