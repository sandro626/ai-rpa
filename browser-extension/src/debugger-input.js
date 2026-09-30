const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DEFAULT_DEBUGGER_CLEANUP_RESERVE_MS = 500;
const DEFAULT_DEBUGGER_RESPONSE_GRACE_MS = 50;
const DEBUGGER_ACTION_WATCHDOG_GRACE_MS = 10;

const debuggerStatesByApi = new WeakMap();

// ---------- JS 对话框拆弹(2026-09-30 真机:菜单/下拉点击后 debugger 通道 ---
// 必死——element.click/snapshot.capture 双超时,而 tab.list/captureVisibleTab
// 畅通;页面 JS 原生对话框(alert/confirm)冻结 debugger 会话是头号形态,
// 此前零处理。自动 dismiss(accept:false):confirm 取「取消」最安全,
// alert 等价,prompt 得 null。MV3 顶层注册 SW 重启安全;替身环境静默跳过。
const dialogGuardInstalled = new WeakSet();

export function ensureJavascriptDialogGuard(chromeApi) {
  const api = chromeApi && chromeApi.debugger;
  if (!api || !api.onEvent || typeof api.onEvent.addListener !== "function") return;
  if (dialogGuardInstalled.has(chromeApi)) return;
  dialogGuardInstalled.add(chromeApi);
  api.onEvent.addListener((source, method, params) => {
    if (method !== "Page.javascriptDialogOpening" || !source || !source.tabId) return;
    try {
      console.info(
        "[aivane] js dialog dismissed:",
        params && params.type,
        String((params && params.message) || "").slice(0, 120)
      );
    } catch {}
    void api
      .sendCommand({ tabId: source.tabId }, "Page.handleJavaScriptDialog", { accept: false })
      .catch(() => undefined);
  });
}

// 有死点不能全死(2026-09-30):NEVER_SETTLES 无限挂起会把该 tab 的命令队列
// 永久吊死(后续命令全排队等恢复,SW 重启才解)。有界恢复窗:到点后尽力
// 补一刀 detach、复位恢复态,让 barrier 收尾、后续命令开新 generation。
const DEBUGGER_RECOVERY_ABANDON_MS = 5000;

async function holdRecoveryBounded(chromeApi, state, target, generation, timing, stage) {
  await new Promise(resolve => {
    timing.setTimeout(resolve, DEBUGGER_RECOVERY_ABANDON_MS);
  });
  try {
    await chromeApi.debugger.detach(target);
  } catch {} // 本就没挂或已断:目的只是清掉可能残留的僵尸会话
  if (state.recoveryStage === stage || state.activeGeneration === generation) {
    state.recoveryPending = false;
    state.recoveryStage = null;
  }
}

export async function dispatchPointerClick(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const point = requirePoint(parameters.point);
  const button = normalizeButton(parameters.button);
  const clickCount = Math.max(1, Number(parameters.clickCount ?? 1));
  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (target, send) => {
    assertCommandActive(parameters);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none"
    });
    await humanPause(parameters);
    assertCommandActive(parameters);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      clickCount
    });
    await humanPause(parameters);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      clickCount
    });
    return { clicked: true, tabId, point, button, clickCount };
  }, debuggerOptions(parameters, "element.click"));
}

export async function dispatchPointerHover(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const point = requirePoint(parameters.point);
  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (_target, send) => {
    assertCommandActive(parameters);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none"
    });
    return { hovered: true, tabId, point };
  }, debuggerOptions(parameters, "element.hover"));
}

export async function dispatchTextInput(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const point = requirePoint(parameters.point);
  const text = String(parameters.text ?? "");
  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (_target, send) => {
    assertCommandActive(parameters);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
    await humanPause(parameters);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
    if (parameters.clear !== false) {
      assertCommandActive(parameters);
      const selectAllModifier = Number(parameters.selectAllModifier ?? (
        String(globalThis.navigator?.platform || "").toLowerCase().includes("mac")
          ? 4
          : 2
      ));
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: selectAllModifier
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: selectAllModifier
      });
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      });
    }
    if (text) {
      assertCommandActive(parameters);
      await send("Input.insertText", { text });
    }
    return { input: true, tabId, textLength: text.length };
  }, debuggerOptions(parameters, "element.input"));
}

export async function dispatchKeyPress(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const point = requirePoint(parameters.point);
  const descriptor = keyDescriptor(parameters.key);
  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (_target, send) => {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1
    });
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode
    });
    return { pressed: true, tabId, key: descriptor.key };
  }, debuggerOptions(parameters, "element.pressKey"));
}

function keyDescriptor(value) {
  const key = String(value || "Enter");
  const known = {
    Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27],
    Backspace: ["Backspace", 8], Delete: ["Delete", 46],
    ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40],
    ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
    Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34], Space: ["Space", 32]
  };
  const entry = known[key];
  if (entry) return { key: entry[0] === "Space" ? " " : entry[0], code: entry[0], keyCode: entry[1] };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { key, code: /[A-Z]/.test(upper) ? `Key${upper}` : key, keyCode: upper.charCodeAt(0) };
  }
  throw new TypeError(`Unsupported key '${key}'.`);
}

async function humanPause(parameters) {
  if (parameters.humanize === false) {
    return;
  }
  const configured = Number(parameters.humanDelayMs ?? 55);
  const base = Number.isFinite(configured)
    ? Math.max(0, Math.min(500, configured))
    : 55;
  const milliseconds = base + Math.floor(Math.random() * Math.max(1, base));
  await new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

export function withDebugger(chromeApi, tabId, action, options = {}) {
  const states = debuggerStates(chromeApi);
  ensureJavascriptDialogGuard(chromeApi);
  const state = states.get(tabId) ?? {
    nextGeneration: 0,
    activeGeneration: null,
    recoveryPending: false,
    recoveryStage: null,
    tail: Promise.resolve()
  };
  states.set(tabId, state);

  if (state.recoveryPending) {
    return waitForDebuggerRecovery(state, options, tabId).then(() =>
      withDebugger(chromeApi, tabId, action, options));
  }

  const response = deferred();
  const generation = ++state.nextGeneration;
  const previous = state.tail;
  const barrier = previous
    .catch(() => undefined)
    .then(async () => {
      if (state.recoveryPending) {
        response.reject(debuggerRecoveryPending(
          options.operation,
          tabId,
          state
        ));
        return;
      }
      state.activeGeneration = generation;
      try {
        await runDebuggerGeneration(
          chromeApi,
          tabId,
          action,
          options,
          state,
          generation,
          response
        );
      } finally {
        if (state.activeGeneration === generation) {
          state.activeGeneration = null;
        }
      }
    });
  const tail = barrier.then(
    () => undefined,
    () => undefined
  ).finally(() => {
    if (
      state.tail === tail &&
      state.recoveryPending === false
    ) {
      states.delete(tabId);
    }
  });
  state.tail = tail;
  return response.promise;
}

async function runDebuggerGeneration(
  chromeApi,
  tabId,
  action,
  options,
  state,
  generation,
  response
) {
  const target = { tabId };
  const timings = options.timings && typeof options.timings === "object"
    ? options.timings
    : {};
  const timing = normalizeTiming(options.timing);
  const commandDeadlineEpochMs = normalizeDeadline(options.deadlineEpochMs);
  const cleanupReserveMs = normalizeCleanupReserve(options.cleanupReserveMs);
  const responseGraceMs = normalizeResponseGrace(
    options.responseGraceMs,
    cleanupReserveMs
  );
  const actionDeadlineEpochMs = reserveCleanupTime(
    commandDeadlineEpochMs,
    cleanupReserveMs,
    timing.now(),
    responseGraceMs
  );
  if (
    actionDeadlineEpochMs != null &&
    actionDeadlineEpochMs <= timing.now()
  ) {
    response.reject(debuggerStageTimeout(
      "queue",
      tabId,
      actionDeadlineEpochMs,
      options.operation
    ));
    return;
  }

  const attachPromise = Promise.resolve().then(() =>
    chromeApi.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION));
  try {
    await awaitDebuggerStage(
      attachPromise,
      actionDeadlineEpochMs,
      "attach",
      tabId,
      timings,
      timing,
      options.operation
    );
  } catch (error) {
    if (error?.code !== "DEBUGGER_STAGE_TIMEOUT") {
      response.reject(error);
      return;
    }
    markRecoveryPending(state, generation, "attach");
    timings.cleanupStatus = "pending";
    updateDebuggerErrorDetails(error, timings);
    response.reject(error);
    let attached = false;
    try {
      await attachPromise;
      attached = true;
      await detachDebuggerToSettlement(
        chromeApi,
        target,
        timings,
        timing,
        "lateDetach"
      );
      timings.cleanupStatus = "settled";
      clearRecoveryPending(state, generation);
    } catch {
      if (!attached) {
        // A rejected late attach means no AIVane debugger session was created.
        clearRecoveryPending(state, generation);
      } else {
        timings.cleanupStatus = "failed";
        markRecoveryPending(state, generation, "lateDetach");
        await holdRecoveryBounded(chromeApi, state, target, generation, timing, "lateDetach");
      }
    }
    return;
  }

  // Page 域开闸:javascriptDialogOpening 事件依赖(拆弹守卫见模块头)。
  // fire-and-forget 直达(send 助手此时尚未声明):失败不阻断命令本体。
  try {
    void chromeApi.debugger.sendCommand(target, "Page.enable", {}).catch(() => {});
  } catch {}

  let actionActive = true;
  let sendSequence = 0;
  const pendingSends = new Map();
  const send = async (method, params = {}) => {
    if (!actionActive) {
      throw debuggerGenerationExpired(
        options.operation,
        tabId,
        generation,
        method
      );
    }
    const stage = `send:${method}`;
    const sendToken = ++sendSequence;
    pendingSends.set(sendToken, stage);
    try {
      return await awaitDebuggerStage(
        () => {
          if (
            actionDeadlineEpochMs != null &&
            actionDeadlineEpochMs <= timing.now()
          ) {
            throw debuggerStageTimeout(
              stage,
              tabId,
              actionDeadlineEpochMs,
              options.operation
            );
          }
          if (!actionActive) {
            throw debuggerGenerationExpired(
              options.operation,
              tabId,
              generation,
              method
            );
          }
          return chromeApi.debugger.sendCommand(target, method, params);
        },
        actionDeadlineEpochMs,
        stage,
        tabId,
        timings,
        timing,
        options.operation
      );
    } finally {
      pendingSends.delete(sendToken);
    }
  };

  const pendingSendStage = () => {
    const iterator = pendingSends.values().next();
    return iterator.done ? "action" : iterator.value;
  };

  let result;
  let failure = null;
  try {
    result = await awaitDebuggerStage(
      Promise.resolve().then(() => action(target, send)),
      actionWatchdogDeadline(
        actionDeadlineEpochMs,
        commandDeadlineEpochMs,
        responseGraceMs
      ),
      "action",
      tabId,
      timings,
      timing,
      options.operation,
      pendingSendStage
    );
  } catch (error) {
    failure = normalizeError(error);
  } finally {
    actionActive = false;
  }

  const detachPromise = detachDebuggerToSettlement(
    chromeApi,
    target,
    timings,
    timing,
    "detach"
  );
  const stageRecoveryPending = failure?.code === "DEBUGGER_STAGE_TIMEOUT";
  if (stageRecoveryPending) {
    markRecoveryPending(
      state,
      generation,
      failure?.details?.debuggerStage || "action"
    );
  }

  const cleanupWaitMs = cleanupResponseWait(
    commandDeadlineEpochMs,
    actionDeadlineEpochMs,
    cleanupReserveMs,
    responseGraceMs,
    timing.now()
  );
  const cleanupOutcome = await settlementWithin(
    detachPromise,
    cleanupWaitMs,
    timing
  );
  if (!cleanupOutcome.settled) {
    markRecoveryPending(state, generation, "detach");
    timings.cleanupStatus = "pending";
  } else if (cleanupOutcome.error) {
    markRecoveryPending(state, generation, "detach");
    timings.cleanupStatus = "failed";
    if (failure) {
      failure = mergeCleanupFailure(failure, cleanupOutcome.error);
    } else {
      timings.cleanupError = cleanupErrorDetails(cleanupOutcome.error);
    }
  } else {
    timings.cleanupStatus = "settled";
    clearRecoveryPending(state, generation);
  }
  updateDebuggerErrorDetails(failure, timings);
  if (failure) {
    response.reject(failure);
  } else {
    response.resolve(result);
  }

  if (!cleanupOutcome.settled) {
    try {
      await detachPromise;
      timings.cleanupStatus = "settled";
      clearRecoveryPending(state, generation);
    } catch {
      timings.cleanupStatus = "failed";
      markRecoveryPending(state, generation, "detach");
      await holdRecoveryBounded(chromeApi, state, target, generation, timing, "detach");
    }
  } else if (cleanupOutcome.error) {
    await holdRecoveryBounded(chromeApi, state, target, generation, timing, "detach");
  }
}

function debuggerStates(chromeApi) {
  let states = debuggerStatesByApi.get(chromeApi);
  if (!states) {
    states = new Map();
    debuggerStatesByApi.set(chromeApi, states);
  }
  return states;
}

async function waitForDebuggerRecovery(state, options, tabId) {
  const timing = normalizeTiming(options.timing);
  const deadlineEpochMs = reserveCleanupTime(
    normalizeDeadline(options.deadlineEpochMs),
    normalizeCleanupReserve(options.cleanupReserveMs),
    timing.now()
  );
  if (deadlineEpochMs == null) {
    throw debuggerRecoveryPending(options.operation, tabId, state);
  }
  const remainingMs = deadlineEpochMs - timing.now();
  if (remainingMs <= 0) {
    throw debuggerRecoveryPending(options.operation, tabId, state);
  }
  let timer = null;
  try {
    const recovered = await Promise.race([
      state.tail.then(() => true),
      new Promise(resolve => {
        timer = timing.setTimeout(() => resolve(false), remainingMs);
      })
    ]);
    if (!recovered) {
      throw debuggerRecoveryPending(options.operation, tabId, state);
    }
  } finally {
    if (timer != null) {
      timing.clearTimeout(timer);
    }
  }
}

async function awaitDebuggerStage(
  execution,
  deadlineEpochMs,
  stage,
  tabId,
  timings,
  timing,
  operation,
  timeoutStageProvider = null
) {
  const startedAt = timing.now();
  let timer = null;
  let failure = null;
  let observedExecution = null;
  const timeoutStage = () => {
    if (typeof timeoutStageProvider !== "function") {
      return stage;
    }
    const candidate = timeoutStageProvider();
    return typeof candidate === "string" && candidate !== ""
      ? candidate
      : stage;
  };
  try {
    if (deadlineEpochMs != null && deadlineEpochMs <= timing.now()) {
      throw debuggerStageTimeout(
        timeoutStage(),
        tabId,
        deadlineEpochMs,
        operation
      );
    }
    observedExecution = Promise.resolve(
      typeof execution === "function" ? execution() : execution
    );
    if (deadlineEpochMs == null) {
      return await observedExecution;
    }
    const remainingMs = deadlineEpochMs - timing.now();
    if (remainingMs <= 0) {
      throw debuggerStageTimeout(
        timeoutStage(),
        tabId,
        deadlineEpochMs,
        operation
      );
    }
    const timeout = new Promise((_, reject) => {
      timer = timing.setTimeout(
        () => reject(debuggerStageTimeout(
          timeoutStage(),
          tabId,
          deadlineEpochMs,
          operation
        )),
        remainingMs
      );
    });
    return await Promise.race([observedExecution, timeout]);
  } catch (error) {
    failure = normalizeError(error);
    throw failure;
  } finally {
    if (timer != null) {
      timing.clearTimeout(timer);
    }
    timings[`${stage}Ms`] = timing.now() - startedAt;
    if (failure) {
      annotateDebuggerError(
        failure,
        stage,
        tabId,
        timings,
        operation
      );
    }
  }
}

async function detachDebuggerToSettlement(
  chromeApi,
  target,
  timings,
  timing,
  stage
) {
  const startedAt = timing.now();
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await chromeApi.debugger.detach(target);
        timings[`${stage}Status`] = attempt === 1
          ? "completed"
          : "retry_completed";
        timings[`${stage}Attempts`] = attempt;
        return;
      } catch (error) {
        const normalized = normalizeError(error);
        timings[`${stage}Attempts`] = attempt;
        timings[`${stage}Error`] = normalized.message;
        if (isTerminalDebuggerDetachError(normalized)) {
          timings[`${stage}Status`] = "already_detached";
          return;
        }
        const detached = await verifyDebuggerDetached(chromeApi, target);
        if (detached === true) {
          timings[`${stage}Status`] = "verified_detached";
          return;
        }
        if (attempt === 2) {
          timings[`${stage}Status`] = detached === false
            ? "still_attached"
            : "failed";
          throw debuggerCleanupFailed(
            target.tabId,
            stage,
            normalized,
            timings[`${stage}Status`]
          );
        }
      }
    }
  } finally {
    timings[`${stage}Ms`] = timing.now() - startedAt;
  }
}

async function settlementWithin(execution, timeoutMs, timing) {
  const observed = Promise.resolve(execution).then(
    value => ({ settled: true, value, error: null }),
    error => ({ settled: true, value: undefined, error: normalizeError(error) })
  );
  if (timeoutMs <= 0) {
    return { settled: false, value: undefined, error: null };
  }
  let timer = null;
  try {
    return await Promise.race([
      observed,
      new Promise(resolve => {
        timer = timing.setTimeout(
          () => resolve({ settled: false, value: undefined, error: null }),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer != null) {
      timing.clearTimeout(timer);
    }
  }
}

async function verifyDebuggerDetached(chromeApi, target) {
  if (typeof chromeApi?.debugger?.getTargets !== "function") {
    return null;
  }
  try {
    const targets = await chromeApi.debugger.getTargets();
    const matching = Array.isArray(targets)
      ? targets.find(candidate => candidate?.tabId === target.tabId)
      : null;
    if (!matching) {
      return true;
    }
    if (matching.attached === false) {
      return true;
    }
    if (matching.attached === true) {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function isTerminalDebuggerDetachError(error) {
  return /(?:debugger is not attached|not attached to the tab|no tab with|no target with|target closed|tab (?:was|has been) closed|closed tab|detached while handling command)/i
    .test(String(error?.message || error));
}

function debuggerCleanupFailed(tabId, stage, cause, cleanupStatus) {
  return commandError(
    "DEBUGGER_CLEANUP_FAILED",
    `Browser debugger cleanup failed for tab ${tabId}.`,
    {
      tabId,
      debuggerStage: stage,
      cleanupStatus,
      cause: String(cause?.message || cause)
    }
  );
}

function mergeCleanupFailure(failure, cleanupError) {
  const details = failure.details && typeof failure.details === "object"
    ? failure.details
    : {};
  failure.details = {
    ...details,
    cleanupError: cleanupErrorDetails(cleanupError)
  };
  return failure;
}

function cleanupErrorDetails(cleanupError) {
  return {
    code: cleanupError.code || "DEBUGGER_CLEANUP_FAILED",
    message: cleanupError.message,
    details: cleanupError.details || null
  };
}

function markRecoveryPending(state, generation, stage) {
  if (state.activeGeneration !== generation) {
    return;
  }
  state.recoveryPending = true;
  state.recoveryStage = stage;
}

function clearRecoveryPending(state, generation) {
  if (state.activeGeneration !== generation) {
    return;
  }
  state.recoveryPending = false;
  state.recoveryStage = null;
}

function debuggerRecoveryPending(operation, tabId, state) {
  return commandError(
    "DEBUGGER_RECOVERY_PENDING",
    `Browser debugger recovery is still pending for tab ${tabId}.`,
    {
      operation: operation || null,
      tabId,
      debuggerStage: state.recoveryStage,
      debuggerGeneration: state.activeGeneration
    }
  );
}

function debuggerGenerationExpired(
  operation,
  tabId,
  generation,
  method
) {
  return commandError(
    "DEBUGGER_GENERATION_EXPIRED",
    `Browser debugger generation ${generation} is no longer active for tab ${tabId}.`,
    {
      operation: operation || null,
      tabId,
      debuggerGeneration: generation,
      method
    }
  );
}

function debuggerStageTimeout(
  stage,
  tabId,
  deadlineEpochMs,
  operation
) {
  return commandError(
    "DEBUGGER_STAGE_TIMEOUT",
    `Browser debugger stage '${stage}' exceeded its deadline.`,
    {
      operation: operation || null,
      debuggerStage: stage,
      tabId,
      deadlineEpochMs
    }
  );
}

function annotateDebuggerError(
  error,
  stage,
  tabId,
  timings,
  operation
) {
  const details = error.details && typeof error.details === "object"
    ? error.details
    : {};
  error.details = {
    ...details,
    operation: details.operation ?? operation ?? null,
    debuggerStage: details.debuggerStage ?? stage,
    tabId: details.tabId ?? tabId,
    debuggerTimings: { ...timings }
  };
  if (!error.code) {
    error.code = "DEBUGGER_COMMAND_FAILED";
  }
}

function updateDebuggerErrorDetails(error, timings) {
  if (!error) {
    return;
  }
  const details = error.details && typeof error.details === "object"
    ? error.details
    : {};
  error.details = {
    ...details,
    debuggerTimings: { ...timings }
  };
}

function reserveCleanupTime(
  deadlineEpochMs,
  reserveMs,
  now,
  minimumReserveMs = 0
) {
  if (deadlineEpochMs == null) {
    return null;
  }
  const remainingMs = deadlineEpochMs - now;
  if (remainingMs <= 0) {
    return deadlineEpochMs;
  }
  const normalReserve = Math.min(
    reserveMs,
    Math.max(1, Math.floor(remainingMs / 2))
  );
  const responseReserve = Math.min(
    Math.max(0, minimumReserveMs),
    remainingMs
  );
  return deadlineEpochMs - Math.max(normalReserve, responseReserve);
}

function normalizeDeadline(value) {
  if (value == null || value === "") {
    return null;
  }
  const deadline = Number(value);
  return Number.isFinite(deadline) ? deadline : null;
}

function normalizeCleanupReserve(value) {
  const reserve = Number(value);
  return Number.isFinite(reserve) && reserve > 0
    ? Math.max(1, Math.floor(reserve))
    : DEFAULT_DEBUGGER_CLEANUP_RESERVE_MS;
}

function normalizeResponseGrace(value, cleanupReserveMs) {
  const grace = Number(value);
  const normalized = Number.isFinite(grace) && grace >= 0
    ? Math.floor(grace)
    : DEFAULT_DEBUGGER_RESPONSE_GRACE_MS;
  return Math.min(cleanupReserveMs, normalized);
}

function cleanupResponseWait(
  commandDeadlineEpochMs,
  actionDeadlineEpochMs,
  cleanupReserveMs,
  responseGraceMs,
  now
) {
  const reservedMs = commandDeadlineEpochMs != null &&
      actionDeadlineEpochMs != null
    ? Math.max(0, commandDeadlineEpochMs - actionDeadlineEpochMs)
    : cleanupReserveMs;
  const nominalWaitMs = Math.max(
    0,
    reservedMs - Math.min(responseGraceMs, reservedMs)
  );
  if (commandDeadlineEpochMs == null) {
    return nominalWaitMs;
  }
  const liveDeadlineBudgetMs = Math.max(
    0,
    commandDeadlineEpochMs - responseGraceMs - now
  );
  return Math.min(nominalWaitMs, liveDeadlineBudgetMs);
}

function actionWatchdogDeadline(
  actionDeadlineEpochMs,
  commandDeadlineEpochMs,
  responseGraceMs
) {
  if (actionDeadlineEpochMs == null) {
    return null;
  }
  if (commandDeadlineEpochMs == null) {
    return actionDeadlineEpochMs;
  }
  const latestDeadline = Math.max(
    actionDeadlineEpochMs,
    commandDeadlineEpochMs - responseGraceMs
  );
  return Math.min(
    actionDeadlineEpochMs + DEBUGGER_ACTION_WATCHDOG_GRACE_MS,
    latestDeadline
  );
}

function normalizeTiming(value) {
  if (
    value &&
    typeof value.now === "function" &&
    typeof value.setTimeout === "function" &&
    typeof value.clearTimeout === "function"
  ) {
    return value;
  }
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeout: timer => globalThis.clearTimeout(timer)
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject
  };
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function debuggerOptions(parameters, operation) {
  return {
    operation,
    deadlineEpochMs: parameters?.commandDeadlineEpochMs
  };
}

function normalizeButton(value) {
  const button = String(value || "left").toLowerCase();
  if (!["left", "middle", "right"].includes(button)) {
    throw commandError("INVALID_ARGUMENT", "button must be left, middle, or right.");
  }
  return button;
}

function requirePoint(value) {
  if (
    !value ||
    !Number.isFinite(Number(value.x)) ||
    !Number.isFinite(Number(value.y))
  ) {
    throw commandError("INVALID_ARGUMENT", "point must contain finite x and y values.");
  }
  return { x: Number(value.x), y: Number(value.y) };
}

function requireInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw commandError("INVALID_ARGUMENT", `${name} must be an integer.`);
  }
  return value;
}

function commandError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertCommandActive(parameters) {
  const raw = parameters?.commandDeadlineEpochMs;
  if (raw == null || raw === "") {
    return;
  }
  const deadline = Number(raw);
  if (Number.isFinite(deadline) && deadline <= Date.now()) {
    throw commandError(
      "COMMAND_EXPIRED",
      "The browser command expired before input dispatch."
    );
  }
}

const MODIFIER_BITS = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Command: 4, Shift: 8 };

export function parseKeyCombo(value) {
  const raw = String(value ?? "");
  const parts = raw.split("+").map(part => part.trim());
  if (!parts.length || parts.some(part => !part)) {
    throw new TypeError(`Unsupported key combo '${raw}'.`);
  }
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const canonical = part.charAt(0).toUpperCase() + part.slice(1);
    const bits = MODIFIER_BITS[part] ?? MODIFIER_BITS[canonical];
    if (bits == null) {
      throw new TypeError(`Unsupported modifier '${part}' in '${raw}'.`);
    }
    modifiers |= bits;
  }
  const descriptor = keyDescriptor(parts[parts.length - 1]);
  return { ...descriptor, modifiers };
}

export async function dispatchPageKeyPress(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const descriptor = parseKeyCombo(parameters.key);
  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (_target, send) => {
    assertCommandActive(parameters);
    const base = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers: descriptor.modifiers
    };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return { pressed: true, tabId, key: String(parameters.key), modifiers: descriptor.modifiers };
  }, debuggerOptions(parameters, "page.pressKey"));
}
