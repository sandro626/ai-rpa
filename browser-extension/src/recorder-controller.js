const STATE_KEY = "aivaneRecorderState";
const CONTENT_SCRIPT_ID = "aivane-recorder-content";
const MIN_SCREENSHOT_INTERVAL_MS = 600;
// A gesture's frame only describes the click it was taken for. Past this the
// page has moved on and the frame is no better than a fresh capture.
const GESTURE_FRAME_TTL_MS = 5_000;
// Pointers go down on plenty of things that never become a recorded action.
// Keeping the last few frames covers the ones that do without growing.
const MAX_TRACKED_GESTURES = 8;

export function createRecorderController(chromeApi, options = {}) {
  if (!chromeApi?.storage?.session || !chromeApi?.scripting || !chromeApi?.tabs) {
    throw new TypeError("Recorder controller requires Chrome extension APIs.");
  }
  const getClient = options.getClient;
  const getBrowserName = typeof options.getBrowserName === "function"
    ? options.getBrowserName : () => "chrome";
  const contentFlushTimeoutMs = Math.max(50, Number(options.contentFlushTimeoutMs) || 5000);
  const contentScriptTimeoutMs = Math.max(50, Number(options.contentScriptTimeoutMs) || 5000);
  if (typeof getClient !== "function") {
    throw new TypeError("Recorder controller requires getClient.");
  }
  let sendQueue = Promise.resolve();
  let controlQueue = Promise.resolve();
  let captureQueue = Promise.resolve();
  let captureState = "unknown";
  let lastScreenshotAt = 0;
  const gestureFrames = new Map();

  async function state() {
    const stored = await chromeApi.storage.session.get(STATE_KEY);
    return normalizeState(stored[STATE_KEY]);
  }

  async function status(syncCore = true) {
    let current = await state();
    if (!syncCore) {
      return current;
    }
    try {
      const core = await (await getClient()).state();
      current = {
        ...current,
        connected: true,
        active: core.active === true,
        state: core.state || "idle",
        sessionId: core.sessionId || null,
        eventCount: Number(core.eventCount || 0),
        error: null
      };
      await saveState(current);
      if (current.active) {
        await enableCapture();
      } else {
        await disableCapture();
      }
    } catch {
      // Recorder is intentionally started on demand through Native Messaging.
      // Do not present an initial offline health check as an extension error.
      current = {
        ...current,
        connected: false,
        error: null
      };
      await saveState(current);
    }
    return current;
  }

  function runControl(operation) {
    const result = controlQueue.then(operation, operation);
    controlQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function start() {
    return runControl(async () => {
      const current = await state();
      if (current.active) {
        return current;
      }
      const [tab] = await chromeApi.tabs.query({
        active: true,
        currentWindow: true
      });
      const local = await chromeApi.storage.local.get([
        "clientId",
        "profileId",
        "browserName"
      ]);
      const context = {
        source: "browser-extension",
        clientId: local.clientId || "",
        profileId: local.profileId || "default",
        browserName: local.browserName || getBrowserName(),
        startTabId: tab?.id ?? null,
        startWindowId: tab?.windowId ?? null,
        startUrl: tab?.url || "",
        startTitle: tab?.title || ""
      };
      const result = await (await getClient()).start(context);
      const next = {
        connected: true,
        active: true,
        state: "recording",
        sessionId: result.sessionId || null,
        eventCount: Number(result.eventCount || 0),
        lastFlowId: null,
        error: null
      };
      await saveState(next);
      await enableCapture();
      return next;
    });
  }

  function pause() {
    return runControl(async () => {
      const result = await (await getClient()).pause();
      const next = {
        ...(await state()),
        connected: true,
        active: true,
        state: "paused",
        eventCount: Number(result.eventCount || 0),
        error: null
      };
      await saveState(next);
      return next;
    });
  }

  function resume() {
    return runControl(async () => {
      const result = await (await getClient()).resume();
      const next = {
        ...(await state()),
        connected: true,
        active: true,
        state: "recording",
        eventCount: Number(result.eventCount || 0),
        error: null
      };
      await saveState(next);
      await enableCapture();
      return next;
    });
  }

  function finish(name = "") {
    return runControl(async () => {
      await flushContentScripts();
      await sendQueue;
      const result = await (await getClient()).finish(name);
      await disableCapture();
      const flowId = result?.flow?.flowId || null;
      const next = {
        connected: true,
        active: false,
        state: "idle",
        sessionId: null,
        eventCount: 0,
        lastFlowId: flowId,
        error: null
      };
      await saveState(next);
      return { ...next, result };
    });
  }

  function discard() {
    return runControl(async () => {
      await (await getClient()).discard();
      await disableCapture();
      const next = {
        connected: true,
        active: false,
        state: "idle",
        sessionId: null,
        eventCount: 0,
        lastFlowId: null,
        error: null
      };
      await saveState(next);
      return next;
    });
  }

  function acceptContentEvent(message, sender) {
    if (message?.type !== "aivane.recorder.event") {
      return Promise.resolve({ accepted: false });
    }
    return enqueueEvent({
      ...(message.event || {}),
      source: "content-script",
      tabId: sender?.tab?.id ?? null,
      windowId: sender?.tab?.windowId ?? null,
      frameId: sender?.frameId ?? 0,
      url: message.event?.url || sender?.tab?.url || "",
      title: message.event?.title || sender?.tab?.title || ""
    }, sender?.tab);
  }

  function recordBrowserEvent(event, tab) {
    const type = String(event?.type || "");
    if (
      !["tab.create", "tab.close", "tab.created", "tab.closed"].includes(type)
      && !isRecordableUrl(event?.url || tab?.url)
    ) {
      return Promise.resolve({ accepted: false, reason: "unsupported_page" });
    }
    return enqueueEvent({
      ...event,
      source: "browser-extension",
      tabId: tab?.id ?? event?.tabId ?? null,
      windowId: tab?.windowId ?? event?.windowId ?? null,
      url: event?.url || tab?.url || "",
      title: event?.title || tab?.title || ""
    }, tab);
  }

  function enqueueEvent(event, tab) {
    const result = sendQueue.then(async () => {
      const current = await state();
      if (!current.active || current.state !== "recording") {
        return { accepted: false, reason: "not_recording" };
      }
      const identity = await chromeApi.storage.local.get([
        "clientId",
        "profileId",
        "browserName"
      ]);
      const enriched = {
        ...event,
        captureClientId: identity.clientId || "",
        profileId: identity.profileId || "default",
        browserName: identity.browserName || getBrowserName()
      };
      const windowBounds = await browserWindowBounds(enriched.windowId);
      if (windowBounds) {
        enriched.browserWindowBounds = windowBounds;
      }
      const screenshot = await captureScreenshot(tab, enriched);
      delete enriched.gestureId;
      enriched.screenshotStatus = screenshot.status;
      if (screenshot.dataUrl) {
        enriched.screenshotData = screenshot.dataUrl;
      }
      if (screenshot.moment) {
        enriched.screenshotMoment = screenshot.moment;
      }
      if (screenshot.capturedAt) {
        enriched.screenshotCapturedAt =
          new Date(screenshot.capturedAt).toISOString();
      }
      if (screenshot.error) {
        enriched.screenshotError = screenshot.error;
      }
      const response = await (await getClient()).event(enriched);
      const next = {
        ...current,
        connected: true,
        eventCount: Number(response.eventCount ?? current.eventCount),
        error: null
      };
      await saveState(next);
      return response;
    });
    sendQueue = result.then(
      () => undefined,
      async error => {
        const current = await state();
        await saveState({
          ...current,
          error: friendlyError(error)
        });
      }
    );
    return result;
  }

  async function browserWindowBounds(windowId) {
    if (!Number.isInteger(windowId) || typeof chromeApi.windows?.get !== "function") {
      return null;
    }
    try {
      const window = await chromeApi.windows.get(windowId);
      const x = Number(window?.left);
      const y = Number(window?.top);
      const width = Number(window?.width);
      const height = Number(window?.height);
      return [x, y, width, height].every(Number.isFinite)
          && width > 0 && height > 0
        ? { x, y, width, height }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Starts the screenshot for a click while the pointer is still down.
   *
   * <p>A capture requested after the click has been reported races the page's
   * own reaction to it: menus close, dropdowns collapse, and the frame that
   * comes back no longer shows the control that was clicked. Starting here
   * puts the request ahead of that reaction, so the frame shows what the
   * reader following the steps needs to look for.
   */
  async function prepareGesture(gestureId, tab) {
    const id = String(gestureId || "");
    if (!id || !tab?.active || !Number.isInteger(tab.windowId)) {
      return { accepted: false, reason: "no_capture_target" };
    }
    const current = await state();
    if (!current.active || current.state !== "recording") {
      return { accepted: false, reason: "not_recording" };
    }
    // Chrome rate-limits captureVisibleTab. Waiting out the limit here would
    // hand back a frame from after the reaction this is meant to precede, so
    // the click falls back to a capture of its own instead.
    if (Date.now() - lastScreenshotAt < MIN_SCREENSHOT_INTERVAL_MS) {
      return { accepted: false, reason: "throttled" };
    }
    const pending = grabFrame(tab);
    void pending.catch(() => {});
    gestureFrames.set(id, pending);
    while (gestureFrames.size > MAX_TRACKED_GESTURES) {
      gestureFrames.delete(gestureFrames.keys().next().value);
    }
    return { accepted: true };
  }

  async function captureScreenshot(tab, event) {
    if (!tab?.active || !Number.isInteger(tab.windowId)) {
      return { status: "inactive_tab", dataUrl: null, moment: "" };
    }
    const prepared = await gestureFrame(event?.gestureId);
    if (prepared) {
      return { ...prepared, moment: "before" };
    }
    const elapsed = Date.now() - lastScreenshotAt;
    if (elapsed < MIN_SCREENSHOT_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(
        resolve,
        MIN_SCREENSHOT_INTERVAL_MS - elapsed
      ));
    }
    return { ...await grabFrame(tab), moment: "after" };
  }

  async function gestureFrame(gestureId) {
    const id = String(gestureId || "");
    if (!id) {
      return null;
    }
    const pending = gestureFrames.get(id);
    gestureFrames.delete(id);
    if (!pending) {
      return null;
    }
    const frame = await pending;
    const stale = Date.now() - frame.capturedAt > GESTURE_FRAME_TTL_MS;
    return frame.status === "captured" && !stale ? frame : null;
  }

  async function grabFrame(tab) {
    try {
      const dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 72
      });
      lastScreenshotAt = Date.now();
      return { status: "captured", dataUrl, capturedAt: lastScreenshotAt };
    } catch (error) {
      return {
        status: "failed",
        dataUrl: null,
        capturedAt: Date.now(),
        error: String(error?.message || error || "Screenshot capture failed")
          .slice(0, 300)
      };
    }
  }

  async function enableCapture() {
    return queueCapture(async () => {
      if (captureState === "enabled") {
        return;
      }
      try {
        await chromeApi.scripting.unregisterContentScripts({
          ids: [CONTENT_SCRIPT_ID]
        });
      } catch {
        // Registration may not exist yet.
      }
      await chromeApi.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches: ["http://*/*", "https://*/*"],
        js: ["src/recorder-content.js"],
        runAt: "document_start",
        persistAcrossSessions: false,
        allFrames: false
      }]);
      const tabs = await chromeApi.tabs.query({});
      await Promise.allSettled(
        tabs
          .filter(tab => isRecordableUrl(tab?.url) && !tab.discarded && !tab.frozen)
          .map(tab => injectCaptureScript(tab.id))
      );
      captureState = "enabled";
    });
  }

  async function disableCapture() {
    return queueCapture(async () => {
      if (captureState === "disabled") {
        return;
      }
      try {
        await chromeApi.scripting.unregisterContentScripts({
          ids: [CONTENT_SCRIPT_ID]
        });
      } catch {
        // Nothing to disable.
      }
      captureState = "disabled";
    });
  }

  async function injectCaptureScript(tabId) {
    let timer;
    try {
      return await Promise.race([
        chromeApi.scripting.executeScript({
          target: { tabId }, files: ["src/recorder-content.js"]
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            "The browser tab did not become ready for recording in time."
          )), contentScriptTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function captureActivatedTab(tab) {
    const current = await state();
    if (!current.active || current.state !== "recording"
      || !Number.isInteger(tab?.id) || !isRecordableUrl(tab?.url)
      || tab.discarded || tab.frozen) return;
    await injectCaptureScript(tab.id);
  }

  function queueCapture(operation) {
    const result = captureQueue.then(operation, operation);
    captureQueue = result.then(
      () => undefined,
      () => {
        captureState = "unknown";
      }
    );
    return result;
  }

  async function flushContentScripts() {
    if (typeof chromeApi.tabs.sendMessage !== "function") {
      return;
    }
    const tabs = await chromeApi.tabs.query({});
    const results = await Promise.allSettled(
      tabs
        // Frozen pages cannot execute message handlers; discarded pages have
        // no live document to flush. Neither should hold up an active page.
        .filter(tab => isRecordableUrl(tab?.url) && !tab.discarded && !tab.frozen)
        .map(async tab => {
          let timer;
          try {
            await Promise.race([
              chromeApi.tabs.sendMessage(tab.id, { type: "aivane.recorder.flush" }),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  const error = new Error("A browser tab did not respond. Recording was not finished. Activate any sleeping recording tabs and retry Finish.");
                  error.code = "RECORDER_FLUSH_TIMEOUT";
                  reject(error);
                }, contentFlushTimeoutMs);
              })
            ]);
          } finally {
            clearTimeout(timer);
          }
        })
    );
    const timedOut = results.find(result => result.status === "rejected"
      && result.reason?.code === "RECORDER_FLUSH_TIMEOUT");
    if (timedOut) throw timedOut.reason;
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  async function flush() {
    await flushContentScripts();
    await sendQueue;
    return state();
  }

  async function saveState(value) {
    const normalized = normalizeState(value);
    await chromeApi.storage.session.set({ [STATE_KEY]: normalized });
    try {
      // A popup notification is best-effort. A closed or suspended recipient
      // must not hold the command queue or prevent recording from finishing.
      void Promise.resolve(chromeApi.runtime.sendMessage({
        type: "aivane.recorder.stateChanged",
        state: normalized
      })).catch(() => {});
    } catch {
      // Popup is usually closed.
    }
    return normalized;
  }

  return {
    state,
    status,
    start,
    pause,
    resume,
    finish,
    discard,
    acceptContentEvent,
    prepareGesture,
    recordBrowserEvent,
    captureActivatedTab,
    flush,
    enableCapture,
    disableCapture
  };
}

export function isRecordableUrl(value) {
  if (!value || !/^https?:/i.test(String(value))) {
    return false;
  }
  try {
    const url = new URL(String(value));
    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.pathname.startsWith("/recorder/")
      && !url.pathname.startsWith("/recorder/test/")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    connected: source.connected === true,
    active: source.active === true,
    state: ["recording", "paused"].includes(source.state)
      ? source.state
      : "idle",
    sessionId: source.sessionId || null,
    eventCount: Math.max(0, Number(source.eventCount || 0)),
    lastFlowId: source.lastFlowId || null,
    error: source.error || null
  };
}

function friendlyError(error) {
  if (error?.code === "RECORDER_TIMEOUT" || error?.name === "TypeError") {
    return "AIVane Recorder is not running. Open AIVane Recorder to continue.";
  }
  return error?.message || String(error);
}
