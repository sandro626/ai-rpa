export const RECORDER_NATIVE_HOST = "com.aivane.recorder";

const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

export async function ensureRecorderAvailable(chromeApi, options = {}) {
  if (typeof options.healthCheck !== "function") {
    throw new TypeError("Recorder healthCheck is required.");
  }
  try {
    const health = await options.healthCheck();
    return {
      ready: true,
      started: false,
      health
    };
  } catch (initialError) {
    const requestId = options.requestId || createRequestId();
    const response = await sendWakeRequest(chromeApi, requestId);
    const timeoutMs = Math.max(
      1_000,
      Number(options.timeoutMs || DEFAULT_START_TIMEOUT_MS)
    );
    const pollIntervalMs = Math.max(
      25,
      Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)
    );
    const deadline = Date.now() + timeoutMs;
    let lastError = initialError;
    while (Date.now() < deadline) {
      try {
        const health = await options.healthCheck();
        return {
          ready: true,
          started: response.started !== false,
          requestId,
          health
        };
      } catch (error) {
        lastError = error;
        await delay(pollIntervalMs);
      }
    }
    const error = new Error(
      "AIVane Recorder started but did not become ready in time."
    );
    error.code = "RECORDER_START_TIMEOUT";
    error.cause = lastError;
    throw error;
  }
}

export async function sendWakeRequest(chromeApi, requestId = createRequestId()) {
  if (typeof chromeApi?.runtime?.sendNativeMessage !== "function") {
    const error = new Error(
      "This browser cannot start AIVane Recorder automatically."
    );
    error.code = "NATIVE_MESSAGING_UNAVAILABLE";
    throw error;
  }
  let response;
  try {
    response = await chromeApi.runtime.sendNativeMessage(
      RECORDER_NATIVE_HOST,
      {
        action: "ensureRecorder",
        requestId
      }
    );
  } catch (cause) {
    const error = new Error(
      "AIVane Recorder is not installed or its browser connection is not registered."
    );
    error.code = "NATIVE_HOST_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
  if (!response?.ok || response.ready !== true) {
    const error = new Error(
      response?.message || "AIVane Recorder could not be started."
    );
    error.code = response?.code || "NATIVE_HOST_START_FAILED";
    error.details = response || null;
    throw error;
  }
  return response;
}

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `wake-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds) {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}
