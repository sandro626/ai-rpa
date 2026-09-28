import {
  DEFAULT_BRIDGE_BASE_URL,
  errorEnvelope,
  parseEnvelope,
  responseEnvelope,
  validateLoopbackEndpoint
} from "./protocol.js";

const DEFAULT_POLL_WAIT_MS = 25000;
const MAX_BACKOFF_MS = 30000;
const DEFAULT_MAX_IN_FLIGHT = 8;

export class LoopbackLongPollClient {
  constructor(options) {
    if (typeof options?.dispatch !== "function") {
      throw new TypeError("dispatch is required.");
    }
    this.dispatch = options.dispatch;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? (milliseconds =>
      new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)));
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_BRIDGE_BASE_URL
    );
    this.clientId = String(options.clientId || "");
    this.bridgeSecret = requireBridgeSecret(options.bridgeSecret);
    this.profileId = String(options.profileId || "default");
    this.browserName = String(options.browserName || "chromium");
    this.extensionVersion = String(options.extensionVersion || "0.0.0");
    this.pollWaitMs = Math.max(
      1000,
      Math.min(30000, Number(options.pollWaitMs ?? DEFAULT_POLL_WAIT_MS))
    );
    const requestedMaxInFlight = Number(
      options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    );
    this.maxInFlight = Number.isFinite(requestedMaxInFlight)
      ? Math.max(1, Math.min(32, requestedMaxInFlight))
      : DEFAULT_MAX_IN_FLIGHT;
    this.now = options.now ?? (() => Date.now());
    this.running = false;
    this.connected = false;
    this.abortControllers = new Set();
    this.inFlight = new Set();
    this.asyncError = null;
  }

  getClientInfo() {
    return {
      clientId: this.clientId,
      profileId: this.profileId,
      browserName: this.browserName,
      connected: this.connected
    };
  }

  async start() {
    if (this.running) {
      return;
    }
    this.asyncError = null;
    this.running = true;
    let backoffMs = 250;
    try {
      while (this.running) {
        try {
          await this.connect();
          backoffMs = 250;
          while (this.running && this.connected) {
            await this.waitForDispatchSlot();
            if (this.asyncError) {
              const error = this.asyncError;
              this.asyncError = null;
              throw error;
            }
            await this.pollOnce();
          }
        } catch (error) {
          this.connected = false;
          if (!this.running) {
            break;
          }
          // Request timeouts and transport resets also abort fetches. Only an
          // explicit stop ends the loop; an abort while running must reconnect.
          console.warn("AIVane bridge reconnect scheduled.", error);
          await this.sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    } finally {
      this.running = false;
      this.connected = false;
    }
  }

  async stop() {
    this.running = false;
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    if (this.connected) {
      try {
        await this.post("disconnect", { clientId: this.clientId });
      } catch {
        // The bridge may already be unavailable.
      }
    }
    this.connected = false;
    await Promise.allSettled(this.inFlight);
    this.asyncError = null;
  }

  async connect() {
    const result = await this.post("connect", {
      clientId: this.clientId,
      profileId: this.profileId,
      browserName: this.browserName,
      extensionVersion: this.extensionVersion
    });
    if (result?.ok !== true) {
      throw bridgeError(result, "Bridge rejected the extension connection.");
    }
    this.connected = true;
    return result;
  }

  async pollOnce() {
    const result = await this.post("poll", {
      clientId: this.clientId,
      waitMs: this.pollWaitMs
    }, this.pollWaitMs + 5000);
    if (result?.ok !== true) {
      throw bridgeError(result, "Bridge poll failed.");
    }
    if (!result.request) {
      return null;
    }

    const task = this.handleRequest(result.request);
    this.trackInFlight(task);
    return result.request;
  }

  async handleRequest(rawRequest) {
    let response;
    try {
      const request = parseEnvelope(rawRequest);
      if (request.type !== "request") {
        throw new TypeError("Poll payload must contain a request envelope.");
      }
      const deadlineEpochMs = Number(request.deadlineEpochMs);
      if (
        Number.isFinite(deadlineEpochMs) &&
        deadlineEpochMs <= this.now()
      ) {
        const error = new Error("The browser command expired before execution.");
        error.code = "COMMAND_EXPIRED";
        throw error;
      }
      response = responseEnvelope(
        request.id,
        await this.dispatch(
          request.method,
          request.params ?? {},
          {
            id: request.id,
            deadlineEpochMs: Number.isFinite(deadlineEpochMs)
              ? deadlineEpochMs
              : null
          }
        )
      );
    } catch (error) {
      const requestId = rawRequest?.id || "invalid-request";
      response = errorEnvelope(String(requestId), error);
    }

    const responseResult = await this.post("respond", {
      clientId: this.clientId,
      ...response
    });
    if (responseResult?.ok !== true) {
      throw bridgeError(responseResult, "Bridge did not accept the command response.");
    }
    return response;
  }

  async waitForIdle() {
    await Promise.allSettled(Array.from(this.inFlight));
    if (this.asyncError) {
      const error = this.asyncError;
      this.asyncError = null;
      throw error;
    }
  }

  async waitForDispatchSlot() {
    while (this.inFlight.size >= this.maxInFlight) {
      await Promise.race(this.inFlight);
    }
  }

  trackInFlight(task) {
    const tracked = Promise.resolve(task)
      .catch(error => {
        this.asyncError = error;
        if (this.running) {
          this.connected = false;
          for (const controller of this.abortControllers) {
            controller.abort();
          }
        }
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
    void tracked.catch(() => {});
  }

  async post(action, body, timeoutMs = 10000) {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timer = globalThis.setTimeout(
      () => controller.abort(),
      Math.max(1000, timeoutMs)
    );
    try {
      const response = await this.fetch(new URL(action, this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          bridgeSecret: this.bridgeSecret
        }),
        signal: controller.signal,
        cache: "no-store"
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = bridgeError(payload, `Bridge returned HTTP ${response.status}.`);
        error.retryable = response.status >= 500;
        throw error;
      }
      return payload;
    } finally {
      globalThis.clearTimeout(timer);
      this.abortControllers.delete(controller);
    }
  }
}

function requireBridgeSecret(value) {
  const normalized = String(value || "");
  if (normalized.length < 32 || normalized.length > 512) {
    throw new TypeError("bridgeSecret must contain between 32 and 512 characters.");
  }
  return normalized;
}

export function normalizeBaseUrl(value) {
  const validated = validateLoopbackEndpoint(value);
  return validated.endsWith("/") ? validated : `${validated}/`;
}

function bridgeError(payload, fallbackMessage) {
  const error = new Error(payload?.error?.message || payload?.message || fallbackMessage);
  error.code = payload?.error?.code || payload?.code || "BRIDGE_HTTP_ERROR";
  error.details = payload?.error?.details ?? null;
  return error;
}
