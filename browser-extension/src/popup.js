import { t, initializeLanguage } from "./language.js";
import {
  DEFAULT_RECORDER_BASE_URL
} from "./recorder-client.js";
import {
  COMPANION_SETUP_URL,
  companionGuidance,
  retainCompanionFailure
} from "./companion.js";

const elements = {
  connectionBadge: document.querySelector("#connectionBadge"),
  statusIcon: document.querySelector("#statusIcon"),
  eyebrow: document.querySelector("#eyebrow"),
  title: document.querySelector("#title"),
  description: document.querySelector("#description"),
  stepCounter: document.querySelector("#stepCounter"),
  stepCount: document.querySelector("#stepCount"),
  errorMessage: document.querySelector("#errorMessage"),
  idleActions: document.querySelector("#idleActions"),
  recordingActions: document.querySelector("#recordingActions"),
  pausedActions: document.querySelector("#pausedActions"),
  startButton: document.querySelector("#startButton"),
  openButton: document.querySelector("#openButton"),
  pauseButton: document.querySelector("#pauseButton"),
  finishButton: document.querySelector("#finishButton"),
  discardButton: document.querySelector("#discardButton"),
  resumeButton: document.querySelector("#resumeButton"),
  pausedFinishButton: document.querySelector("#pausedFinishButton"),
  pausedDiscardButton: document.querySelector("#pausedDiscardButton"),
  setupActions: document.querySelector("#setupActions"),
  setupLink: document.querySelector("#setupLink"),
  setupLinkLabel: document.querySelector("#setupLinkLabel"),
  retryButton: document.querySelector("#retryButton")
};

elements.setupLink.href = COMPANION_SETUP_URL;

let currentState = null;
let busy = false;
let retryAction = null;

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function refresh(syncCore = true) {
  currentState = retainCompanionFailure(
    currentState,
    await send("aivane.recorder.status", { syncCore })
  );
  render();
}

async function command(action) {
  if (busy) {
    return;
  }
  busy = true;
  if (action === "start") {
    retryAction = "start";
  }
  if (action === "start" && currentState?.connected !== true) {
    currentState = {
      ...(currentState || {}),
      starting: true,
      error: null,
      errorCode: null
    };
  }
  render();
  try {
    const result = await send("aivane.recorder.command", { action });
    if (!result?.ok) {
      throw commandError(result, "commandFailed");
    }
    currentState = result.state || currentState;
    if (action === "finish" && result.lastFlowId) {
      currentState = {
        ...currentState,
        lastFlowId: result.lastFlowId
      };
      renderCompleted();
      setTimeout(() => openRecorder(result.lastFlowId), 650);
      return;
    }
    render();
  } catch (error) {
    currentState = {
      ...(currentState || {}),
      starting: false,
      error: error?.message || String(error),
      errorCode: error?.code || null
    };
    render();
  } finally {
    busy = false;
    render();
  }
}

function commandError(result, fallbackKey) {
  const error = new Error(result?.message || t(fallbackKey));
  error.code = result?.code || null;
  return error;
}

function renderCompanionGuidance(guidance) {
  elements.idleActions.hidden = true;
  elements.setupActions.hidden = false;
  elements.stepCounter.hidden = true;
  elements.statusIcon.className = "status-icon idle";
  elements.errorMessage.hidden = true;
  elements.eyebrow.textContent = t(guidance.eyebrow);
  elements.title.textContent = t(guidance.title);
  elements.description.textContent = t(guidance.description);

  const setupIsPrimary = guidance.primary === "setup";
  elements.setupActions.className = `action-stack${setupIsPrimary ? "" : " retry-first"}`;
  elements.setupLink.className = setupIsPrimary ? "primary-button" : "text-button";
  elements.setupLink.hidden = false;
  elements.setupLinkLabel.dataset.i18n = guidance.setupLabel;
  elements.setupLinkLabel.textContent = t(guidance.setupLabel);
  elements.retryButton.hidden = !guidance.retry;
  elements.retryButton.className = guidance.primary === "retry" ? "primary-button" : "text-button";
}

function render() {
  const state = currentState || {
    connected: false,
    active: false,
    state: "idle",
    eventCount: 0
  };
  elements.connectionBadge.textContent = state.connected ? t("connected") : t("disconnected");
  if (state.starting) {
    elements.connectionBadge.textContent = t("starting");
  }
  elements.connectionBadge.className =
    `connection-badge ${state.connected ? "connected" : "offline"}`;
  elements.errorMessage.hidden = !state.error;
  elements.errorMessage.textContent = state.error || "";

  const recording = state.active && state.state === "recording";
  const paused = state.active && state.state === "paused";
  const guidance = recording || paused || state.starting
    ? null
    : companionGuidance(state.errorCode);
  if (guidance) {
    elements.recordingActions.hidden = true;
    elements.pausedActions.hidden = true;
    renderCompanionGuidance(guidance);
    disableWhileBusy();
    return;
  }
  elements.setupActions.hidden = true;
  elements.idleActions.hidden = recording || paused;
  elements.recordingActions.hidden = !recording;
  elements.pausedActions.hidden = !paused;
  elements.stepCounter.hidden = !recording && !paused;
  elements.stepCount.textContent = String(state.eventCount || 0);
  elements.statusIcon.className = `status-icon ${
    recording ? "recording" : paused ? "paused" : "idle"
  }`;

  if (state.starting) {
    elements.eyebrow.textContent = t("starting");
    elements.title.textContent = t("startingTitle");
    elements.description.textContent = t("startingDescription");
  } else if (recording) {
    elements.eyebrow.textContent = t("recording");
    elements.title.textContent = t("recordingTitle");
    elements.description.textContent =
      t("recordingDescription");
  } else if (paused) {
    elements.eyebrow.textContent = t("paused");
    elements.title.textContent = t("pausedTitle");
    elements.description.textContent =
      t("pausedDescription");
  } else {
    elements.eyebrow.textContent = t("ready");
    elements.title.textContent = t("idleTitle");
    elements.description.textContent =
      t("idleDescription");
  }
  disableWhileBusy();
}

function disableWhileBusy() {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy;
  }
}

function renderCompleted() {
  elements.statusIcon.className = "status-icon idle";
  elements.eyebrow.textContent = t("completed");
  elements.title.textContent = t("completedTitle");
  elements.description.textContent = t("completedDescription");
  elements.stepCounter.hidden = true;
  elements.idleActions.hidden = true;
  elements.recordingActions.hidden = true;
  elements.pausedActions.hidden = true;
  elements.setupActions.hidden = true;
}

async function openRecorder(flowId = null) {
  const result = await send("aivane.recorder.command", { action: "open" });
  if (!result?.ok) {
    throw commandError(result, "openFailed");
  }
  const url = new URL(DEFAULT_RECORDER_BASE_URL);
  url.pathname = "/recorder/";
  url.search = "";
  url.hash = flowId ? `#/flows/${encodeURIComponent(flowId)}` : "#/";
  await chrome.tabs.create({ url: url.href, active: true });
  window.close();
}

elements.startButton.addEventListener("click", () => command("start"));
elements.retryButton.addEventListener("click", () => {
  if (retryAction === "open") return openRecorderFromPopup();
  if (retryAction === "start") return command("start");
  return refresh(true);
});
elements.pauseButton.addEventListener("click", () => command("pause"));
elements.resumeButton.addEventListener("click", () => command("resume"));
elements.finishButton.addEventListener("click", () => command("finish"));
elements.pausedFinishButton.addEventListener("click", () => command("finish"));
elements.discardButton.addEventListener("click", () => command("discard"));
elements.pausedDiscardButton.addEventListener("click", () => command("discard"));
async function openRecorderFromPopup() {
  if (busy) {
    return;
  }
  busy = true;
  retryAction = "open";
  currentState = {
    ...(currentState || {}),
    starting: true,
    error: null,
    errorCode: null
  };
  render();
  try {
    await openRecorder();
    retryAction = null;
  } catch (error) {
    currentState = {
      ...(currentState || {}),
      starting: false,
      error: error?.message || String(error),
      errorCode: error?.code || null
    };
  } finally {
    busy = false;
    render();
  }
}

elements.openButton.addEventListener("click", openRecorderFromPopup);

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "aivane.recorder.stateChanged") {
    currentState = retainCompanionFailure(currentState, message.state);
    render();
  }
});

await initializeLanguage(() => render());
void refresh(true);
document.querySelector("#settingsButton").addEventListener("click", () => chrome.runtime.openOptionsPage());
