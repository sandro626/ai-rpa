import { withDebugger } from "./debugger-input.js";

export async function setFileInputFiles(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const locator = normalizeLocator(parameters.locator ?? parameters.selector);
  if (locator.strategy !== "css") {
    throw commandError(
      "UNSUPPORTED_LOCATOR",
      "File input assignment currently requires a CSS locator."
    );
  }
  const selector = locator.value;
  const files = Array.isArray(parameters.files)
    ? parameters.files.map((file, index) =>
        requireNonEmptyString(file, `files[${index}]`))
    : [];
  if (files.length === 0) {
    throw commandError("INVALID_ARGUMENT", "files must contain at least one path.");
  }

  assertCommandActive(parameters);
  return withDebugger(chromeApi, tabId, async (_target, send) => {
    await send("DOM.enable");
    const documentResult = await send("DOM.getDocument", {
      depth: -1,
      pierce: true
    });
    const queryResult = await send("DOM.querySelectorAll", {
        nodeId: documentResult.root.nodeId,
        selector
    });
    const nodeId = queryResult.nodeIds?.[locator.index];
    if (!nodeId) {
      throw commandError(
        "ELEMENT_NOT_FOUND",
        `No file input matched selector '${selector}'.`
      );
    }
    assertCommandActive(parameters);
    await send("DOM.setFileInputFiles", {
      files,
      nodeId
    });
    return {
      assigned: true,
      tabId,
      selector,
      locator,
      fileCount: files.length
    };
  }, {
    operation: "element.setInputFiles",
    deadlineEpochMs: parameters.commandDeadlineEpochMs
  });
}

function normalizeLocator(value) {
  if (typeof value === "string") {
    return {
      strategy: "css",
      value: requireNonEmptyString(value, "selector"),
      index: 0
    };
  }
  if (!value || typeof value !== "object") {
    throw commandError(
      "INVALID_ARGUMENT",
      "locator must be a CSS selector or locator object."
    );
  }
  const strategy = String(value.strategy || "css").toLowerCase();
  const locatorValue = requireNonEmptyString(
    value.value ?? value.selector,
    "locator.value"
  );
  const index = value.index == null ? 0 : Number(value.index);
  if (!Number.isInteger(index) || index < 0) {
    throw commandError(
      "INVALID_ARGUMENT",
      "locator.index must be a non-negative integer."
    );
  }
  return { strategy, value: locatorValue, index };
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

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
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
      "The browser command expired before file assignment."
    );
  }
}
