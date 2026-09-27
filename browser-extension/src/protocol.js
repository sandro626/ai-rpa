export const PROTOCOL_VERSION = "1.0";
export const DEFAULT_BRIDGE_BASE_URL =
  "http://127.0.0.1:32146/aivane/browser/v1/";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function createId(prefix = "msg") {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function createSecret() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

export function validateLoopbackEndpoint(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw protocolError("INVALID_ENDPOINT", "Bridge endpoint must be a non-empty string.");
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw protocolError("INVALID_ENDPOINT", "Bridge endpoint is not a valid URL.", {
      cause: error.message
    });
  }

  if (endpoint.protocol !== "http:") {
    throw protocolError(
      "INVALID_ENDPOINT",
      "Bridge endpoint must use http:// because only loopback connections are allowed."
    );
  }
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw protocolError(
      "NON_LOOPBACK_ENDPOINT",
      "Bridge endpoint must resolve explicitly to localhost, 127.0.0.1, or [::1]."
    );
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw protocolError(
      "INVALID_ENDPOINT",
      "Bridge endpoint must not contain credentials or a URL fragment."
    );
  }
  return endpoint.href;
}

export function requestEnvelope(id, method, params = {}) {
  return {
    type: "request",
    protocolVersion: PROTOCOL_VERSION,
    id: requireNonEmptyString(id, "id"),
    method: requireNonEmptyString(method, "method"),
    params: params ?? {}
  };
}

export function responseEnvelope(id, result) {
  return {
    type: "response",
    protocolVersion: PROTOCOL_VERSION,
    id: requireNonEmptyString(id, "id"),
    ok: true,
    result: result ?? null
  };
}

export function errorEnvelope(id, error) {
  return {
    type: "response",
    protocolVersion: PROTOCOL_VERSION,
    id: requireNonEmptyString(id, "id"),
    ok: false,
    error: serializeError(error)
  };
}

export function eventEnvelope(event, data = {}, sequence = 0) {
  return {
    type: "event",
    protocolVersion: PROTOCOL_VERSION,
    event: requireNonEmptyString(event, "event"),
    sequence,
    timestamp: new Date().toISOString(),
    data: data ?? {}
  };
}

export function parseEnvelope(rawValue) {
  let value = rawValue;
  if (typeof rawValue === "string") {
    try {
      value = JSON.parse(rawValue);
    } catch (error) {
      throw protocolError("INVALID_JSON", "Bridge message is not valid JSON.", {
        cause: error.message
      });
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("INVALID_MESSAGE", "Bridge message must be a JSON object.");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw protocolError(
      "UNSUPPORTED_PROTOCOL",
      `Expected protocol ${PROTOCOL_VERSION}, received ${String(value.protocolVersion)}.`
    );
  }

  switch (value.type) {
    case "request":
      requireNonEmptyString(value.id, "id");
      requireNonEmptyString(value.method, "method");
      break;
    case "response":
      requireNonEmptyString(value.id, "id");
      if (typeof value.ok !== "boolean") {
        throw protocolError("INVALID_MESSAGE", "Response field 'ok' must be boolean.");
      }
      break;
    case "event":
      requireNonEmptyString(value.event, "event");
      break;
    default:
      throw protocolError(
        "INVALID_MESSAGE",
        "Bridge message type must be request, response, or event."
      );
  }
  return value;
}

export function serializeError(error) {
  const candidate = error && typeof error === "object" ? error : {};
  return {
    code: String(candidate.code || candidate.name || "BROWSER_BRIDGE_ERROR"),
    message: String(candidate.message || error || "Unknown browser bridge error."),
    retryable: candidate.retryable === true,
    details: candidate.details ?? null
  };
}

export function protocolError(code, message, details = null) {
  const error = new Error(message);
  error.name = "BrowserBridgeProtocolError";
  error.code = code;
  error.details = details;
  return error;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw protocolError("INVALID_MESSAGE", `Message field '${name}' must be a non-empty string.`);
  }
  return value;
}
