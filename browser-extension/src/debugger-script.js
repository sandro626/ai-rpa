import { withDebugger } from "./debugger-input.js";

const ISOLATED_WORLD_NAME = "aivane-browser-bridge";
const worldContexts = new Map();

export async function executeDebuggerScript(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const source = requireNonEmptyString(parameters.source, "source");
  const serializedArguments = JSON.stringify(parameters.arguments ?? null)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const expression = parameters.mode === "body"
    ? `(async (arguments) => {${source}\n})(${serializedArguments})`
    : `(async (arguments) => (${source}))(${serializedArguments})`;

  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (_target, send) => {
    await send("Page.enable");
    await send("Runtime.enable");
    const frameTree = await send("Page.getFrameTree");
    const frames = flattenFrameTree(frameTree?.frameTree);
    const selectedFrames = await selectFrames(
      chromeApi,
      tabId,
      frames,
      parameters
    );
    pruneWorldContexts(tabId, frames);
    const results = [];
    for (const frame of selectedFrames) {
      assertCommandActive(parameters);
      const contextKey = worldContextKey(tabId, frame.id);
      let contextId = worldContexts.get(contextKey);
      if (!Number.isInteger(contextId)) {
        contextId = await createWorld(send, frame.id);
        worldContexts.set(contextKey, contextId);
      }
      let evaluation;
      try {
        evaluation = await evaluate(send, expression, contextId, parameters);
      } catch (error) {
        if (!isMissingContextError(error)) {
          throw error;
        }
        worldContexts.delete(contextKey);
        contextId = await createWorld(send, frame.id);
        worldContexts.set(contextKey, contextId);
        evaluation = await evaluate(send, expression, contextId, parameters);
      }
      if (evaluation?.exceptionDetails) {
        throw commandError(
          "SCRIPT_EXECUTION_FAILED",
          formatException(evaluation.exceptionDetails),
          {
            tabId,
            frameId: frame.id,
            exceptionDetails: evaluation.exceptionDetails
          }
        );
      }
      results.push({
        frameId: frame.id,
        url: frame.url ?? "",
        result: remoteValue(evaluation?.result)
      });
    }

    if (parameters.allFrames === true) {
      return results;
    }
    return results[0]?.result ?? null;
  }, {
    operation: "script.execute",
    deadlineEpochMs: parameters.commandDeadlineEpochMs
  });
}

async function createWorld(send, frameId) {
  const world = await send("Page.createIsolatedWorld", {
    frameId,
    worldName: ISOLATED_WORLD_NAME,
    grantUniveralAccess: false
  });
  if (!Number.isInteger(world?.executionContextId)) {
    throw commandError(
      "SCRIPT_CONTEXT_UNAVAILABLE",
      `No isolated execution context was created for frame ${frameId}.`
    );
  }
  return world.executionContextId;
}

async function evaluate(send, expression, contextId, parameters) {
  assertCommandActive(parameters);
  return send("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
}

function isMissingContextError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("cannot find context with specified id")) {
    return true;
  }
  return (
    message.includes("execution context") &&
    (
      message.includes("not found") ||
      message.includes("cannot find") ||
      message.includes("destroyed")
    )
  );
}

function pruneWorldContexts(tabId, frames) {
  const live = new Set(frames.map(frame => worldContextKey(tabId, frame.id)));
  const prefix = `${tabId}:`;
  for (const key of worldContexts.keys()) {
    if (key.startsWith(prefix) && !live.has(key)) {
      worldContexts.delete(key);
    }
  }
}

function worldContextKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

async function selectFrames(chromeApi, tabId, frames, parameters) {
  if (frames.length === 0) {
    throw commandError(
      "FRAME_NOT_FOUND",
      `No document frame is available in tab ${tabId}.`
    );
  }
  if (parameters.allFrames === true) {
    return frames;
  }

  if (parameters.frameId == null || Number(parameters.frameId) === 0) {
    return [frames[0]];
  }

  const requestedFrameId = requireInteger(parameters.frameId, "frameId");
  const webFrames = await chromeApi.webNavigation?.getAllFrames?.({ tabId });
  const requested = Array.isArray(webFrames)
    ? webFrames.find(frame => frame.frameId === requestedFrameId)
    : null;
  if (!requested) {
    throw commandError(
      "FRAME_NOT_FOUND",
      `Chrome frame ${requestedFrameId} was not found in tab ${tabId}.`
    );
  }
  const matches = frames.filter(frame =>
    String(frame.url || "") === String(requested.url || "")
  );
  if (matches.length !== 1) {
    throw commandError(
      "FRAME_MAPPING_AMBIGUOUS",
      `Chrome frame ${requestedFrameId} could not be mapped uniquely to a document frame.`,
      {
        tabId,
        frameId: requestedFrameId,
        url: requested.url,
        candidateCount: matches.length
      }
    );
  }
  return matches;
}

function flattenFrameTree(root) {
  if (!root?.frame?.id) {
    return [];
  }
  const result = [{
    id: root.frame.id,
    parentId: root.frame.parentId ?? null,
    url: root.frame.url ?? ""
  }];
  for (const child of root.childFrames || []) {
    result.push(...flattenFrameTree(child));
  }
  return result;
}

function remoteValue(value) {
  if (!value || value.type === "undefined") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  if (value.unserializableValue != null) {
    return String(value.unserializableValue);
  }
  return null;
}

function formatException(details) {
  const description = details?.exception?.description;
  if (description) {
    return String(description);
  }
  if (details?.text) {
    return String(details.text);
  }
  return "The browser script failed.";
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
      "The browser command expired before script execution."
    );
  }
}

function requireInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw commandError("INVALID_ARGUMENT", `${name} must be an integer.`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw commandError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
  }
  return value;
}

function commandError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
