import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckpointCoordinator,
  startPersonalEventWake,
} from "../src/foursday-checkpoint-coordinator.mjs";

const wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

test("checkpoint coordinator serializes checks and keeps the strongest pending wake", async () => {
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise((accept) => { releaseFirst = accept; });
  const coordinator = createCheckpointCoordinator({
    performCheck: async ({ wakeSource }) => {
      calls.push(wakeSource);
      if (calls.length === 1) await firstGate;
    },
    diagnose: () => {},
    fallbackMs: 60_000,
  });
  const first = coordinator.check({ wakeSource: "manual" });
  await wait(0);
  await coordinator.check({ wakeSource: "fallback" });
  await coordinator.check({ wakeSource: "dws_event" });
  await coordinator.check({ wakeSource: "filesystem" });
  releaseFirst();
  await first;
  for (let attempt = 0; calls.length < 2 && attempt < 20; attempt += 1) await wait(1);
  assert.deepEqual(calls, ["manual", "dws_event"]);
  coordinator.stop();
});

test("checkpoint coordinator debounces external wake requests", async () => {
  const calls = [];
  const coordinator = createCheckpointCoordinator({
    performCheck: async ({ wakeSource }) => calls.push(wakeSource),
    diagnose: () => {},
    fallbackMs: 60_000,
    debounceMs: 5,
  });
  coordinator.request("fallback");
  coordinator.request("filesystem");
  coordinator.request("dws_event");
  await wait(20);
  assert.deepEqual(calls, ["dws_event"]);
  coordinator.stop();
});

test("personal event wake owns ready and closed state projection", async () => {
  const state = {};
  const diagnostics = [];
  const events = [];
  let callbacks;
  const controller = { ready: Promise.resolve(), stop: async () => {} };
  const result = await startPersonalEventWake({
    enabled: true,
    dws: {
      createPersonalEventWake: (value) => {
        callbacks = value;
        return controller;
      },
    },
    state,
    persist: async () => {},
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    onEvent: (event) => events.push(event),
    diagnose: (value) => diagnostics.push(value),
  });
  assert.equal(result, controller);
  await wait(0);
  assert.deepEqual(state.eventWake, {
    enabled: true,
    ready: true,
    errorCode: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  callbacks.onEvent({ id: "event" });
  callbacks.onDiagnostic("dws_event_closed:stream");
  assert.deepEqual(events, [{ id: "event" }]);
  assert.equal(state.eventWake.ready, false);
  assert.equal(state.eventWake.errorCode, "dws_event_closed");
  assert.deepEqual(diagnostics, ["dws_event_closed:stream"]);
});

test("personal event wake degrades explicitly when unavailable", async () => {
  const state = {};
  const diagnostics = [];
  const result = await startPersonalEventWake({
    enabled: true,
    dws: {
      createPersonalEventWake: () => {
        const error = new Error("unavailable");
        error.code = "stream_unavailable";
        throw error;
      },
    },
    state,
    persist: async () => {},
    diagnose: (value) => diagnostics.push(value),
  });
  assert.equal(result, null);
  assert.equal(state.eventWake.ready, false);
  assert.equal(state.eventWake.errorCode, "stream_unavailable");
  assert.deepEqual(diagnostics, ["dws_event_wake_unavailable:stream_unavailable"]);
});
