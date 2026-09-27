export const DEFAULT_RECORDER_BASE_URL =
  "http://127.0.0.1:32146/aivane/recorder/v1";

export class RecorderApiClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_RECORDER_BASE_URL)
      .replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.timeoutMs = Math.max(500, Number(options.timeoutMs || 10000));
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("RecorderApiClient requires fetch.");
    }
  }

  health() {
    return this.request("GET", "/health");
  }

  state() {
    return this.request("GET", "/recording");
  }

  start(context = {}) {
    return this.request("POST", "/recordings/start", { context });
  }

  event(event) {
    return this.request("POST", "/recordings/events", event);
  }

  pause() {
    return this.request("POST", "/recordings/pause", {});
  }

  resume() {
    return this.request("POST", "/recordings/resume", {});
  }

  finish(name = "") {
    return this.request("POST", "/recordings/finish", { name });
  }

  discard() {
    return this.request("POST", "/recordings/discard", {});
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-AIVane-Recorder-Client": "browser-extension"
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = new Error(
          payload.message || payload.errorMessage || `Recorder HTTP ${response.status}`
        );
        error.code = payload.code || "RECORDER_REQUEST_FAILED";
        error.status = response.status;
        error.details = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(
          "AIVane Recorder did not respond in time."
        );
        timeoutError.code = "RECORDER_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
