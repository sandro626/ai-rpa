import { createCommandRouter } from "./command-router.js";
import { LoopbackLongPollClient } from "./loopback-client.js";
import {
  DEFAULT_BRIDGE_BASE_URL,
  createId,
  createSecret
} from "./protocol.js";
import {
  RecorderApiClient,
  DEFAULT_RECORDER_BASE_URL
} from "./recorder-client.js";
import { createRecorderController } from "./recorder-controller.js";
import { ensureRecorderAvailable } from "./native-messaging.js";
import { COMPANION_SETUP_URL } from "./companion.js";

const RECONNECT_ALARM = "aivane-browser-bridge-reconnect";
const LEGACY_BRIDGE_BASE_URL = "http://127.0.0.1:32145/aivane/browser/v1/";
const CONFIG_KEYS = new Set([
  "bridgeBaseUrl",
  "bridgeSecret",
  "clientId",
  "profileId",
  "browserName",
  "pollWaitMs"
]);

let client = null;
let startPromise = null;

async function loadConfiguration() {
  const stored = await chrome.storage.local.get([...CONFIG_KEYS]);
  const clientId = stored.clientId || createId("browser");
  const bridgeSecret = stored.bridgeSecret || createSecret();
  if (!stored.clientId || !stored.bridgeSecret) {
    await chrome.storage.local.set({ clientId, bridgeSecret });
  }
  const baseUrl = stored.bridgeBaseUrl === LEGACY_BRIDGE_BASE_URL
    ? DEFAULT_BRIDGE_BASE_URL
    : stored.bridgeBaseUrl || DEFAULT_BRIDGE_BASE_URL;
  if (stored.bridgeBaseUrl === LEGACY_BRIDGE_BASE_URL) {
    await chrome.storage.local.set({ bridgeBaseUrl: baseUrl });
  }
  return {
    baseUrl,
    bridgeSecret,
    clientId,
    profileId: stored.profileId || "default",
    browserName: stored.browserName || detectBrowserName(),
    pollWaitMs: stored.pollWaitMs,
    extensionVersion: chrome.runtime.getManifest().version
  };
}

const recorder = createRecorderController(chrome, {
  getBrowserName: detectBrowserName,
  getClient: async () => new RecorderApiClient({
    baseUrl: DEFAULT_RECORDER_BASE_URL
  })
});

async function startBridge() {
  if (startPromise) {
    return startPromise;
  }
  startPromise = (async () => {
    if (client) {
      await client.stop();
    }
    const configuration = await loadConfiguration();
    const storedSessions = await chrome.storage.session.get("browserSessions");
    let nextClient;
    const browserDispatch = createCommandRouter(chrome, {
      getClientInfo: () => nextClient.getClientInfo(),
      initialSessions: storedSessions.browserSessions || [],
      onSessionsChanged: browserSessions =>
        chrome.storage.session.set({ browserSessions })
    });
    const dispatch = async (method, parameters, metadata) => {
      if (method === "recorder.capture.sync") {
        return recorder.status(true);
      }
      if (method === "recorder.capture.flush") {
        return recorder.flush();
      }
      if (method === "recorder.capture.disable") {
        await recorder.disableCapture();
        return recorder.state();
      }
      return browserDispatch(method, parameters, metadata);
    };
    nextClient = new LoopbackLongPollClient({
      ...configuration,
      dispatch
    });
    client = nextClient;
    void nextClient.start().catch(error => {
      console.error("AIVane browser bridge stopped unexpectedly.", error);
    });
    await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  })().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

function detectBrowserName() {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Edg/")) {
    return "edge";
  }
  if (userAgent.includes("Chrome/")) {
    return "chrome";
  }
  return "chromium";
}

chrome.runtime.onInstalled.addListener(details => {
  void startBridge();
  void recorder.status(true);
  if (details?.reason === "install") {
    void openSetupWhenCompanionMissing();
  }
});
chrome.runtime.onStartup.addListener(() => {
  void startBridge();
  void recorder.status(true);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM && !client?.running) {
    void startBridge();
  }
  if (alarm.name === RECONNECT_ALARM) {
    void recorder.status(true);
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    Object.keys(changes).some(key => CONFIG_KEYS.has(key))
  ) {
    void startBridge();
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "aivane.bridge.wake") {
    void startBridge().then(
      () => sendResponse({ ok: true }),
      error => sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }
  if (message?.type === "aivane.recorder.event") {
    void recorder.acceptContentEvent(message, _sender).then(sendResponse).catch(error => {
      sendResponse({
        accepted: false,
        message: error?.message || String(error)
      });
    });
    return true;
  }
  if (message?.type === "aivane.recorder.prepare") {
    void recorder.prepareGesture(message.gestureId, _sender?.tab)
      .then(sendResponse)
      .catch(error => {
        sendResponse({
          accepted: false,
          message: error?.message || String(error)
        });
      });
    return true;
  }
  if (message?.type === "aivane.recorder.status") {
    void recorder.status(message.syncCore !== false).then(sendResponse).catch(error => {
      sendResponse({
        connected: false,
        active: false,
        state: "idle",
        eventCount: 0,
        error: error?.message || String(error)
      });
    });
    return true;
  }
  if (message?.type === "aivane.recorder.command") {
    void handleRecorderCommand(message).then(sendResponse).catch(error => {
      sendResponse({
        ok: false,
        code: error?.code || "RECORDER_COMMAND_FAILED",
        message: error?.message || String(error)
      });
    });
    return true;
  }
  if (message?.type !== "aivane.browser.status") {
    return false;
  }
  void (async () => {
    const configuration = await loadConfiguration();
    sendResponse({
      ok: true,
      running: client?.running === true,
      connected: client?.connected === true,
      client: client?.getClientInfo() ?? null,
      configuration: {
        baseUrl: configuration.baseUrl,
        clientId: configuration.clientId,
        profileId: configuration.profileId,
        browserName: configuration.browserName,
        extensionVersion: configuration.extensionVersion
      }
    });
  })().catch(error => {
    sendResponse({
      ok: false,
      message: error?.message || String(error)
    });
  });
  return true;
});

async function handleRecorderCommand(message) {
  switch (message.action) {
    case "language-ready":
      await ensureRecorderReady();
      return { ok: true };
    case "start":
      await ensureRecorderReady();
      {
        const state = await recorder.start();
        return { ok: true, state };
      }
    case "open":
      await ensureRecorderReady();
      return { ok: true, state: await recorder.status(true) };
    case "pause":
      return { ok: true, state: await recorder.pause() };
    case "resume":
      return { ok: true, state: await recorder.resume() };
    case "finish":
      return { ok: true, ...(await recorder.finish(message.name || "")) };
    case "discard":
      return { ok: true, state: await recorder.discard() };
    default:
      throw new Error(`Unsupported Recorder command: ${message.action}`);
  }
}

/**
 * A first install without the desktop companion is a dead end: the popup can
 * only report a failure once the user has already tried to record. Probe the
 * loopback API once and send that user to the setup page instead. An
 * unreachable probe is the expected case here, so it is not an error.
 */
async function openSetupWhenCompanionMissing() {
  const api = new RecorderApiClient({
    baseUrl: DEFAULT_RECORDER_BASE_URL,
    timeoutMs: 1_000
  });
  try {
    await api.health();
    return;
  } catch {
    await chrome.tabs.create({ url: COMPANION_SETUP_URL, active: true });
  }
}

async function ensureRecorderReady() {
  const api = new RecorderApiClient({
    baseUrl: DEFAULT_RECORDER_BASE_URL,
    timeoutMs: 1_000
  });
  await ensureRecorderAvailable(chrome, {
    requestId: createId("recorder-wake"),
    healthCheck: () => api.health()
  });
  await startBridge();
}

chrome.tabs.onCreated.addListener(tab => {
  void recorder.recordBrowserEvent({
    type: "tab.create",
    openerTabId: tab.openerTabId ?? null
  }, tab).catch(() => {});
});

chrome.tabs.onActivated.addListener(activeInfo => {
  void chrome.tabs.get(activeInfo.tabId).then(tab => {
    void recorder.captureActivatedTab(tab).catch(() => {});
    return recorder.recordBrowserEvent({ type: "tab.switch" }, tab);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.frozen === false || changeInfo.discarded === false || changeInfo.status === "complete") {
    void recorder.captureActivatedTab(tab).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void recorder.recordBrowserEvent({
    type: "tab.close",
    tabId,
    windowId: removeInfo.windowId,
    windowClosing: removeInfo.isWindowClosing === true
  }, null).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) {
    return;
  }
  void chrome.tabs.get(details.tabId).then(tab => recorder.recordBrowserEvent({
    type: "navigate",
    transitionType: details.transitionType || "",
    transitionQualifiers: details.transitionQualifiers || [],
    url: details.url
  }, tab)).catch(() => {});
});

void startBridge();
void recorder.status(true);
