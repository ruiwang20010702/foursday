const wakePriority = new Map([
  ["dws_event", 4],
  ["filesystem", 3],
  ["fallback", 2],
  ["startup", 1],
  ["manual", 0],
]);

function strongerWakeSource(current, candidate) {
  if (!current) return candidate;
  return (wakePriority.get(candidate) ?? -1) > (wakePriority.get(current) ?? -1)
    ? candidate
    : current;
}

export function createCheckpointCoordinator({
  performCheck,
  diagnose,
  fallbackMs,
  debounceMs = 250,
} = {}) {
  if (typeof performCheck !== "function" || typeof diagnose !== "function") {
    throw new Error("Foursday checkpoint ports are invalid");
  }
  if (!Number.isSafeInteger(fallbackMs) || fallbackMs <= 0) {
    throw new Error("Foursday checkpoint fallback is invalid");
  }
  let running = false;
  let pending = false;
  let pendingWakeSource = null;
  let debounceTimer = null;
  let fallbackTimer = null;

  const reportFailure = (error) => {
    diagnose(`dws_sidecar_check_failed:${String(error?.code ?? error?.name ?? "error")}`);
  };

  const check = async (options = {}) => {
    const wakeSource = options.wakeSource ?? "manual";
    if (running) {
      pending = true;
      pendingWakeSource = strongerWakeSource(pendingWakeSource, wakeSource);
      return;
    }
    running = true;
    try {
      return await performCheck(options);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        const source = pendingWakeSource ?? "manual";
        pendingWakeSource = null;
        queueMicrotask(() => check({ wakeSource: source }).catch(reportFailure));
      }
    }
  };

  const request = (wakeSource = "filesystem") => {
    pendingWakeSource = strongerWakeSource(pendingWakeSource, wakeSource);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const source = pendingWakeSource ?? wakeSource;
      pendingWakeSource = null;
      check({ wakeSource: source }).catch(reportFailure);
    }, debounceMs);
  };

  const startFallback = () => {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(() => request("fallback"), fallbackMs);
  };

  const stop = () => {
    clearInterval(fallbackTimer);
    clearTimeout(debounceTimer);
    fallbackTimer = null;
    debounceTimer = null;
  };

  return {
    check,
    request,
    startFallback,
    stop,
    isRunning: () => running,
  };
}

export async function startPersonalEventWake({
  enabled,
  dws,
  state,
  persist,
  now = () => new Date(),
  onEvent,
  diagnose,
} = {}) {
  if (!state || typeof persist !== "function" || typeof diagnose !== "function") {
    throw new Error("Foursday event wake ports are invalid");
  }
  if (!enabled || typeof dws?.createPersonalEventWake !== "function") {
    state.eventWake = {
      enabled: false,
      ready: false,
      errorCode: null,
      updatedAt: now().toISOString(),
    };
    await persist();
    return null;
  }

  state.eventWake = {
    enabled: true,
    ready: false,
    errorCode: null,
    updatedAt: now().toISOString(),
  };
  await persist();
  let controller;
  try {
    controller = dws.createPersonalEventWake({
      onEvent,
      onDiagnostic: (value) => {
        diagnose(value);
        if (String(value).startsWith("dws_event_closed:")) {
          state.eventWake = {
            enabled: true,
            ready: false,
            errorCode: "dws_event_closed",
            updatedAt: now().toISOString(),
          };
          persist().catch(() => {});
        }
      },
    });
  } catch (error) {
    state.eventWake = {
      enabled: true,
      ready: false,
      errorCode: String(error?.code ?? "dws_event_unavailable").slice(0, 80),
      updatedAt: now().toISOString(),
    };
    diagnose(`dws_event_wake_unavailable:${state.eventWake.errorCode}`);
    await persist();
    return null;
  }
  if (!controller) return null;
  controller.ready.then(async () => {
    state.eventWake = {
      enabled: true,
      ready: true,
      errorCode: null,
      updatedAt: now().toISOString(),
    };
    await persist();
  }).catch(async (error) => {
    state.eventWake = {
      enabled: true,
      ready: false,
      errorCode: String(error?.code ?? "dws_event_unavailable").slice(0, 80),
      updatedAt: now().toISOString(),
    };
    diagnose(`dws_event_wake_unavailable:${state.eventWake.errorCode}`);
    await persist();
  });
  return controller;
}
