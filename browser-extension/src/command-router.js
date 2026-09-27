import { executeDomCommand } from "./dom-command.js";
import { setFileInputFiles } from "./debugger-file-input.js";
import { executeDebuggerScript } from "./debugger-script.js";
import {
  dispatchPointerClick,
  dispatchPointerHover,
  dispatchKeyPress,
  dispatchTextInput,
  dispatchPageKeyPress,
  withDebugger
} from "./debugger-input.js";
import { normalizeDomLocator } from "./selector-compat.js";
import { captureSnapshot } from "./snapshot.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const QUEUE_RELEASE_SAFE_TIMEOUT_METHODS = new Set([
  "snapshot.capture",
  "screenshot.capture"
]);
const COMMAND_RESPONSE_GRACE_MS = 25;
const SCREENSHOT_CLEANUP_RESERVE_MS = 250;

export function createCommandRouter(chromeApi, options = {}) {
  if (!chromeApi?.tabs || !chromeApi?.scripting) {
    throw new TypeError("A Chrome extension API object is required.");
  }

  const sessions = new Map(
    (Array.isArray(options.initialSessions) ? options.initialSessions : [])
      .filter(session => session?.sessionId)
      .map(session => [String(session.sessionId), { ...session }])
  );
  const commandQueues = new Map();
  const persistSessions = async () => {
    if (typeof options.onSessionsChanged === "function") {
      await options.onSessionsChanged(
        Array.from(sessions.values(), session => ({ ...session }))
      );
    }
  };
  const handlers = {
    async "bridge.ping"() {
      return {
        extensionId: chromeApi.runtime.id,
        extensionVersion: chromeApi.runtime.getManifest().version,
        platform: await chromeApi.runtime.getPlatformInfo(),
        pagePressKey: true
      };
    },

    async "session.attach"(parameters) {
      const sessionId = requireNonEmptyString(parameters.sessionId, "sessionId");
      const client = options.getClientInfo?.() ?? {};
      const requestedProfile = parameters.profileId == null
        ? null
        : String(parameters.profileId);
      const clientProfile = client.profileId == null ? null : String(client.profileId);
      if (
        requestedProfile &&
        clientProfile &&
        requestedProfile !== clientProfile &&
        parameters.allowSingleClientFallback !== true
      ) {
        throw commandError(
          "PROFILE_MISMATCH",
          `Requested profile '${requestedProfile}' is not connected.`
        );
      }
      const existingSession = sessions.get(sessionId);
      if (existingSession) {
        const liveTabs = [];
        for (const tabId of existingSession.tabIds || []) {
          try {
            liveTabs.push(await chromeApi.tabs.get(tabId));
          } catch {
            // Discard tabs that the user already closed.
          }
        }
        if (liveTabs.length > 0) {
          assertCommandActive(parameters);
          const tabIds = liveTabs.map(liveTab => liveTab.id);
          const currentTabId = tabIds.includes(existingSession.tabId)
            ? existingSession.tabId
            : tabIds.at(-1);
          const restored = {
            ...existingSession,
            clientId: client.clientId ?? null,
            browserName: client.browserName ?? null,
            profileId: requestedProfile || clientProfile,
            tabId: currentTabId,
            tabIds,
            attached: true
          };
          sessions.set(sessionId, restored);
          await persistSessions();
          return restored;
        }
      }
      let tab = null;
      if (parameters.createNewTab !== false) {
        assertCommandActive(parameters);
        tab = await createNewBrowserTab(chromeApi);
      } else if (parameters.attachUrl != null && String(parameters.attachUrl).trim()) {
        const expectedUrl = normalizeAttachUrl(parameters.attachUrl);
        const candidates = (await chromeApi.tabs.query({}))
          .filter(candidate => normalizeAttachUrl(candidate?.url) === expectedUrl);
        if (candidates.length === 0) {
          throw commandError(
            "ATTACH_TAB_NOT_FOUND",
            `No existing browser tab matches '${String(parameters.attachUrl)}'.`
          );
        }
        if (candidates.length > 1) {
          throw commandError(
            "ATTACH_TAB_AMBIGUOUS",
            `Multiple existing browser tabs match '${String(parameters.attachUrl)}'.`,
            {
              tabIds: candidates.map(candidate => candidate.id)
            }
          );
        }
        [tab] = candidates;
      } else if (parameters.attachActiveTab !== false) {
        [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
          [tab] = await chromeApi.tabs.query({ currentWindow: true });
        }
        if (!tab) {
          assertCommandActive(parameters);
          tab = await chromeApi.tabs.create({ active: true, url: "about:blank" });
        }
      }
      assertCommandActive(parameters);
      const session = {
        sessionId,
        clientId: client.clientId ?? null,
        browserName: client.browserName ?? null,
        profileId: requestedProfile || clientProfile,
        tabId: tab?.id ?? null,
        tabIds: tab?.id == null ? [] : [tab.id],
        attached: true
      };
      sessions.set(sessionId, session);
      await persistSessions();
      return session;
    },

    async "session.get"(parameters) {
      return requireSession(sessions, parameters.sessionId);
    },

    async "session.detach"(parameters) {
      const session = requireSession(sessions, parameters.sessionId);
      const tabIds = Array.from(new Set(session.tabIds || []))
        .filter(Number.isInteger);
      const liveTabIds = [];
      for (const tabId of tabIds) {
        try {
          await chromeApi.tabs.get(tabId);
          liveTabIds.push(tabId);
        } catch {
          // The user may have already closed the tab.
        }
      }
      assertCommandActive(parameters);
      sessions.delete(session.sessionId);
      if (parameters.closeOwnedTabs === true && liveTabIds.length > 0) {
        await chromeApi.tabs.remove(
          liveTabIds.length === 1 ? liveTabIds[0] : liveTabIds
        );
      }
      await persistSessions();
      return {
        ...session,
        tabIds,
        closedTabIds: parameters.closeOwnedTabs === true ? liveTabIds : [],
        attached: false
      };
    },

    async "tab.list"(parameters) {
      if (parameters.sessionId != null) {
        const session = requireSession(sessions, parameters.sessionId);
        const tabs = [];
        for (const tabId of session.tabIds || []) {
          try {
            tabs.push(await chromeApi.tabs.get(tabId));
          } catch {
            // A user may have closed a session tab manually.
          }
        }
        session.tabIds = tabs.map(tab => tab.id);
        if (!session.tabIds.includes(session.tabId)) {
          session.tabId = session.tabIds.at(-1) ?? null;
        }
        await persistSessions();
        return tabs.map(normalizeTab);
      }
      return (await chromeApi.tabs.query(
        parameters.query ?? { currentWindow: true }
      )).map(normalizeTab);
    },

    async "tab.get"(parameters) {
      return normalizeTab(
        await chromeApi.tabs.get(requireInteger(parameters.tabId, "tabId"))
      );
    },

    async "tab.create"(parameters) {
      const createProperties = {
        active: parameters.active !== false
      };
      if (parameters.url != null) {
        createProperties.url = requireNonEmptyString(parameters.url, "url");
      }
      if (Number.isInteger(parameters.windowId)) {
        createProperties.windowId = parameters.windowId;
      }
      if (Number.isInteger(parameters.index)) {
        createProperties.index = parameters.index;
      }
      assertCommandActive(parameters);
      const tab = normalizeTab(await chromeApi.tabs.create(createProperties));
      updateSessionTab(sessions, parameters.sessionId, tab.tabId, true);
      await persistSessions();
      return tab;
    },

    async "tab.activate"(parameters) {
      const tabId = await resolveTabId(chromeApi, parameters, sessions);
      assertCommandActive(parameters);
      const tab = await chromeApi.tabs.update(tabId, { active: true });
      if (tab.windowId != null && chromeApi.windows?.update) {
        await chromeApi.windows.update(tab.windowId, { focused: true });
      }
      const normalized = normalizeTab(tab);
      updateSessionTab(sessions, parameters.sessionId, normalized.tabId, true);
      await persistSessions();
      return normalized;
    },

    async "tab.close"(parameters) {
      const requestedSession = parameters.sessionId == null
        ? null
        : requireSession(sessions, parameters.sessionId);
      let tabIds = Array.isArray(parameters.tabIds)
        ? parameters.tabIds.map((value, index) =>
            requireInteger(value, `tabIds[${index}]`))
        : [await resolveTabId(chromeApi, parameters, sessions)];
      const closedTabs = [];
      for (const tabId of tabIds) {
        try {
          closedTabs.push(normalizeTab(await chromeApi.tabs.get(tabId)));
        } catch {
          // chrome.tabs.remove below returns the authoritative close failure.
        }
      }
      assertCommandActive(parameters);
      await chromeApi.tabs.remove(tabIds.length === 1 ? tabIds[0] : tabIds);
      for (const session of sessions.values()) {
        session.tabIds = (session.tabIds || []).filter(
          tabId => !tabIds.includes(tabId)
        );
        if (tabIds.includes(session.tabId)) {
          session.tabId = session.tabIds.at(-1) ?? null;
        }
      }
      await persistSessions();
      let active = null;
      if (requestedSession && Number.isInteger(requestedSession.tabId)) {
        try {
          active = await chromeApi.tabs.get(requestedSession.tabId);
        } catch {
          requestedSession.tabId = null;
        }
      } else if (!requestedSession) {
        [active] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      }
      return {
        closed: true,
        tabIds,
        closedTabs,
        tabId: requestedSession?.tabId ?? active?.id ?? null,
        activeTabId: requestedSession?.tabId ?? active?.id ?? null,
        url: active?.url ?? "",
        title: active?.title ?? ""
      };
    },

    async "tab.navigate"(parameters) {
      const tabId = requireInteger(parameters.tabId, "tabId");
      const url = requireNonEmptyString(parameters.url, "url");
      const navigation = parameters.waitForComplete === false
        ? null
        : armNavigationWait(chromeApi, tabId, parameters);
      try {
        assertCommandActive(parameters);
        const updated = await chromeApi.tabs.update(tabId, { url });
        return navigation
          ? normalizeTab(await navigation.promise)
          : normalizeTab(updated);
      } catch (error) {
        navigation?.cancel();
        throw error;
      }
    },

    async "tab.reload"(parameters) {
      const tabId = requireInteger(parameters.tabId, "tabId");
      const navigation = parameters.waitForComplete === false
        ? null
        : armNavigationWait(chromeApi, tabId, parameters);
      try {
        assertCommandActive(parameters);
        await chromeApi.tabs.reload(tabId, {
          bypassCache: parameters.bypassCache === true
        });
        return navigation
          ? normalizeTab(await navigation.promise)
          : { reloaded: true, tabId };
      } catch (error) {
        navigation?.cancel();
        throw error;
      }
    },

    async "tab.back"(parameters) {
      const tabId = requireInteger(parameters.tabId, "tabId");
      const navigation = parameters.waitForComplete === false
        ? null
        : armNavigationWait(chromeApi, tabId, parameters);
      try {
        assertCommandActive(parameters);
        await chromeApi.tabs.goBack(tabId);
        return navigation
          ? normalizeTab(await navigation.promise)
          : { navigated: true, tabId, direction: "back" };
      } catch (error) {
        navigation?.cancel();
        throw error;
      }
    },

    async "tab.forward"(parameters) {
      const tabId = requireInteger(parameters.tabId, "tabId");
      const navigation = parameters.waitForComplete === false
        ? null
        : armNavigationWait(chromeApi, tabId, parameters);
      try {
        assertCommandActive(parameters);
        await chromeApi.tabs.goForward(tabId);
        return navigation
          ? normalizeTab(await navigation.promise)
          : { navigated: true, tabId, direction: "forward" };
      } catch (error) {
        navigation?.cancel();
        throw error;
      }
    },

    async "tab.wait"(parameters) {
      return normalizeTab(await waitForTab(
        chromeApi,
        requireInteger(parameters.tabId, "tabId"),
        parameters
      ));
    },

    async "script.execute"(parameters) {
      assertCommandActive(parameters);
      return executeDebuggerScript(chromeApi, parameters);
    },

    async "element.get"(parameters) {
      return executeDom(chromeApi, "get", parameters);
    },

    async "element.getAll"(parameters) {
      return executeDom(chromeApi, "getAll", parameters);
    },

    async "element.query"(parameters) {
      return executeDom(chromeApi, "query", parameters);
    },

    async "element.queryAll"(parameters) {
      return executeDom(chromeApi, "queryAll", parameters);
    },

    async "element.click"(parameters) {
      await waitForElement(
        chromeApi,
        parameters,
        parameters.force === true ? "visible" : "enabled"
      );
      const prepared = await executeDom(chromeApi, "preparePointer", parameters);
      assertCommandActive(parameters);
      const result = await dispatchPointerClick(chromeApi, {
        ...parameters,
        point: prepared.point
      });
      return { ...result, element: prepared.element };
    },

    async "element.input"(parameters) {
      await waitForElement(
        chromeApi,
        parameters,
        parameters.useJs === true ? "attached" : "enabled"
      );
      if (parameters.useJs === true) {
        assertCommandActive(parameters);
        const result = await executeDom(chromeApi, "input", parameters);
        if (parameters.verify === true) {
          await verifyInputValue(
            chromeApi,
            parameters,
            String(result?.value ?? "")
          );
        }
        return result;
      }
      const prepared = await executeDom(chromeApi, "preparePointer", parameters);
      assertCommandActive(parameters);
      const requested = String(parameters.text ?? parameters.value ?? "");
      const expected = parameters.clear === false
        ? String(prepared.element?.value ?? prepared.element?.text ?? "") + requested
        : requested;
      const result = await dispatchTextInput(chromeApi, {
        ...parameters,
        text: requested,
        point: prepared.point
      });
      if (parameters.verify === true) {
        await verifyInputValue(chromeApi, parameters, expected);
      }
      return { ...result, element: prepared.element };
    },

    async "page.pressKey"(parameters) {
      assertCommandActive(parameters);
      return dispatchPageKeyPress(chromeApi, parameters);
    },

    async "element.pressKey"(parameters) {
      await waitForElement(chromeApi, parameters, "enabled");
      const prepared = await executeDom(chromeApi, "preparePointer", parameters);
      assertCommandActive(parameters);
      const result = await dispatchKeyPress(chromeApi, {
        ...parameters,
        point: prepared.point
      });
      return { ...result, element: prepared.element };
    },

    async "element.select"(parameters) {
      await waitForElement(chromeApi, parameters, "enabled");
      assertCommandActive(parameters);
      return executeDom(chromeApi, "select", parameters);
    },

    async "element.hover"(parameters) {
      await waitForElement(chromeApi, parameters, "visible");
      const prepared = await executeDom(chromeApi, "preparePointer", parameters);
      assertCommandActive(parameters);
      const result = await dispatchPointerHover(chromeApi, {
        ...parameters,
        point: prepared.point
      });
      return { ...result, element: prepared.element };
    },

    async "element.getText"(parameters) {
      await waitForElement(chromeApi, parameters, "attached");
      return executeDom(chromeApi, "getText", parameters);
    },

    async "element.getAttribute"(parameters) {
      await waitForElement(chromeApi, parameters, "attached");
      return executeDom(chromeApi, "getAttribute", parameters);
    },

    async "element.wait"(parameters) {
      return executeDom(chromeApi, "wait", parameters);
    },

    async "element.setInputFiles"(parameters) {
      await waitForElement(chromeApi, parameters, "attached");
      assertCommandActive(parameters);
      return setFileInputFiles(chromeApi, parameters);
    },

    async "snapshot.capture"(parameters) {
      const tabId = requireInteger(parameters.tabId, "tabId");
      const tab = await chromeApi.tabs.get(tabId);
      const url = String(tab?.url || "");
      if (url && !isScriptablePageUrl(url)) {
        throw commandError(
          "UNSUPPORTED_PAGE_URL",
          `Accessibility snapshots are unavailable for '${url}'.`,
          { tabId, url }
        );
      }
      return captureSnapshot(chromeApi, parameters);
    },

    async "screenshot.capture"(parameters) {
      const tabId = requireInteger(parameters.tabId, "tabId");
      const format = parameters.format === "jpeg" ? "jpeg" : "png";
      const timings = {};
      const startedAt = Date.now();
      let clip = null;
      if (parameters.locator) {
        await waitForElement(chromeApi, parameters, "visible");
        const prepared = await executeDom(chromeApi, "preparePointer", parameters);
        const rectangle = prepared.element.rectangle;
        clip = {
          x: rectangle.x,
          y: rectangle.y,
          width: rectangle.width,
          height: rectangle.height,
          scale: 1
        };
      }
      assertCommandActive(parameters);
      const tab = await chromeApi.tabs.get(tabId);
      let fallbackReason = null;
      if (
        parameters.fullPage !== true &&
        !clip &&
        tab?.active === true &&
        Number.isInteger(tab.windowId) &&
        typeof chromeApi.tabs.captureVisibleTab === "function"
      ) {
        try {
          const visibleStartedAt = Date.now();
          const dataUrl = await withScreenshotStageDeadline(
            Promise.resolve().then(() =>
              chromeApi.tabs.captureVisibleTab(
                tab.windowId,
                screenshotImageOptions(parameters, format)
              )),
            parameters,
            "captureVisibleTab",
            tabId,
            timings
          );
          timings.captureVisibleTabMs = Date.now() - visibleStartedAt;
          const currentTab = await chromeApi.tabs.get(tabId);
          if (
            currentTab?.active !== true ||
            currentTab.windowId !== tab.windowId
          ) {
            fallbackReason = "target_tab_became_inactive";
          } else {
            timings.totalMs = Date.now() - startedAt;
            return {
              tabId,
              format,
              data: screenshotDataFromUrl(dataUrl),
              strategy: "visible-tab",
              timings
            };
          }
        } catch (error) {
          if (isScreenshotDeadlineError(error)) {
            throw addScreenshotErrorDetails(
              error,
              "visible-tab",
              tabId,
              timings
            );
          }
          fallbackReason = String(error?.code || "visible_tab_capture_failed");
        }
      } else if (parameters.fullPage === true) {
        fallbackReason = "full_page_requires_cdp";
      } else if (clip) {
        fallbackReason = "element_clip_requires_cdp";
      } else {
        fallbackReason = "target_tab_is_inactive";
      }

      const debuggerTimings = {};
      try {
        const result = await withDebugger(
          chromeApi,
          tabId,
          async (_target, send) => {
            if (parameters.fullPage === true && !clip) {
              const metrics = await send("Page.getLayoutMetrics");
              const size = metrics.cssContentSize || metrics.contentSize;
              clip = {
                x: 0,
                y: 0,
                width: size.width,
                height: size.height,
                scale: 1
              };
            }
            assertCommandActive(parameters);
            const captured = await send("Page.captureScreenshot", {
              ...screenshotImageOptions(parameters, format),
              fromSurface: true,
              captureBeyondViewport: parameters.fullPage === true,
              clip: clip ?? undefined
            });
            if (typeof captured?.data !== "string" || captured.data === "") {
              throw commandError(
                "SCREENSHOT_DATA_INVALID",
                "Page.captureScreenshot returned no image data.",
                { tabId }
              );
            }
            return captured.data;
          },
          {
            operation: "screenshot.capture",
            deadlineEpochMs: commandDeadline(parameters),
            cleanupReserveMs: SCREENSHOT_CLEANUP_RESERVE_MS,
            timings: debuggerTimings
          }
        );
        timings.debugger = debuggerTimings;
        timings.totalMs = Date.now() - startedAt;
        return {
          tabId,
          format,
          data: result,
          strategy: "cdp",
          fallbackReason,
          timings
        };
      } catch (error) {
        timings.debugger = debuggerTimings;
        timings.totalMs = Date.now() - startedAt;
        throw addScreenshotErrorDetails(
          error,
          "cdp",
          tabId,
          timings,
          fallbackReason
        );
      }
    }
  };

  return async function dispatch(method, parameters = {}, metadata = {}) {
    const handler = handlers[method];
    if (!handler) {
      throw commandError("UNSUPPORTED_METHOD", `Unsupported bridge method: ${method}.`);
    }
    const source = parameters && typeof parameters === "object" ? parameters : {};
    const normalized = {
      ...source,
      commandDeadlineEpochMs: metadata.deadlineEpochMs != null
        && Number.isFinite(Number(metadata.deadlineEpochMs))
        ? Number(metadata.deadlineEpochMs)
        : null
    };
    if (
      normalized.sessionId != null &&
      !method.startsWith("session.") &&
      !sessions.has(String(normalized.sessionId))
    ) {
      throw commandError(
        "SESSION_NOT_ATTACHED",
        `Session '${String(normalized.sessionId)}' is not attached.`
      );
    }
    const execute = async () => {
      assertCommandActive(normalized);
      const execution = handler(normalized);
      if (!QUEUE_RELEASE_SAFE_TIMEOUT_METHODS.has(method)) {
        return execution;
      }
      return withQueueReleasingDeadline(execution, normalized, method);
    };
    const queueKey = normalized.sessionId != null
      ? `session:${String(normalized.sessionId)}`
      : (Number.isInteger(normalized.tabId)
        ? `tab:${normalized.tabId}`
        : null);
    if (!queueKey) {
      return execute();
    }

    const previous = commandQueues.get(queueKey) ?? Promise.resolve();
    const result = previous.then(execute);
    const tail = result.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      if (commandQueues.get(queueKey) === tail) {
        commandQueues.delete(queueKey);
      }
    });
    commandQueues.set(queueKey, tail);
    return result;
  };
}

async function createNewBrowserTab(chromeApi) {
  try {
    return await chromeApi.tabs.create({
      active: true,
      url: "about:blank"
    });
  } catch (error) {
    if (!/no current window/i.test(String(error?.message || error))
        || !chromeApi.windows?.create) {
      throw error;
    }
    const createdWindow = await chromeApi.windows.create({
      focused: true,
      url: "about:blank"
    });
    const tab = createdWindow?.tabs?.[0];
    if (!tab) {
      throw new Error("Browser window was created without an initial tab.");
    }
    return tab;
  }
}

function normalizeAttachUrl(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return raw.replace(/#.*$/, "");
  }
}

async function executeDom(chromeApi, action, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");
  const target = { tabId };
  if (Number.isInteger(parameters.frameId)) {
    target.frameIds = [parameters.frameId];
  }
  const normalizedParameters = parameters.locator == null
    ? parameters
    : {
        ...parameters,
        locator: normalizeDomLocator(parameters.locator)
      };
  const results = await chromeApi.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: executeDomCommand,
    args: [{ action, parameters: normalizedParameters }]
  });
  const first = results[0];
  if (!first) {
    throw commandError("NO_SCRIPT_RESULT", "The isolated DOM command returned no result.");
  }
  if (first.error) {
    throw commandError(
      "DOM_COMMAND_FAILED",
      `The isolated DOM command failed: ${String(first.error)}`
    );
  }
  if (first.result == null && action === "preparePointer") {
    throw commandError(
      "NO_SCRIPT_RESULT",
      "The isolated DOM command returned no pointer target."
    );
  }
  return first.result ?? null;
}

async function waitForElement(chromeApi, parameters, state) {
  const requestedTimeoutMs = Math.max(
    0,
    Number(parameters.waitTimeoutMs ?? parameters.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
  );
  const timeoutMs = Math.min(
    requestedTimeoutMs,
    remainingCommandTimeout({
      ...parameters,
      timeoutMs: requestedTimeoutMs
    })
  );
  return executeDom(chromeApi, "wait", {
    ...parameters,
    state,
    timeoutMs
  });
}

async function verifyInputValue(chromeApi, parameters, expected) {
  const timeoutMs = Math.min(
    1000,
    remainingCommandTimeout({
      ...parameters,
      timeoutMs: Number(parameters.verifyTimeoutMs ?? 750)
    })
  );
  const deadline = Date.now() + timeoutMs;
  let actual = null;
  let consecutiveMatches = 0;
  do {
    assertCommandActive(parameters);
    actual = await executeDom(chromeApi, "getEditableValue", parameters);
    if (String(actual ?? "") === expected) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= 2) {
        return actual;
      }
    } else {
      consecutiveMatches = 0;
    }
    await delayWithinDeadline(50, parameters);
  } while (Date.now() <= deadline);

  throw commandError(
    "INPUT_VERIFICATION_FAILED",
    "The target element did not retain the requested input value.",
    {
      expected,
      actual: actual == null ? null : String(actual)
    }
  );
}

export function armNavigationWait(chromeApi, tabId, options = {}) {
  if (!chromeApi.webNavigation) {
    throw commandError(
      "WEB_NAVIGATION_UNAVAILABLE",
      "The webNavigation extension permission is required for reliable navigation waits."
    );
  }

  const waitUntil = String(options.waitUntil || "load").toLowerCase();
  const targetEventName = waitUntil === "commit"
    ? "onCommitted"
    : (waitUntil === "domcontentloaded"
      ? "onDOMContentLoaded"
      : "onCompleted");
  const targetEvent = chromeApi.webNavigation[targetEventName];
  if (!targetEvent?.addListener || !targetEvent?.removeListener) {
    throw commandError(
      "WEB_NAVIGATION_UNAVAILABLE",
      `chrome.webNavigation.${targetEventName} is unavailable.`
    );
  }

  const timeoutMs = remainingCommandTimeout(options);
  let settled = false;
  let timer = null;
  const listeners = [];
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = () => {
    if (timer != null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    for (const [event, listener] of listeners) {
      event.removeListener(listener);
    }
    listeners.length = 0;
  };
  const finish = (callback, value) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    callback(value);
  };
  const matches = details => {
    if (
      details?.tabId !== tabId ||
      Number(details?.frameId ?? 0) !== 0
    ) {
      return false;
    }
    const url = String(details?.url || "");
    return matchesNavigationUrl(url, options);
  };
  const complete = async details => {
    if (!matches(details) || settled) {
      return;
    }
    try {
      assertCommandActive(options);
      if (waitUntil === "networkidle") {
        await delayWithinDeadline(
          Math.max(100, Number(options.quietMs ?? 500)),
          options
        );
      }
      assertCommandActive(options);
      const tab = await chromeApi.tabs.get(tabId);
      if (!matchesNavigationUrl(String(tab?.url || details?.url || ""), options)) {
        return;
      }
      finish(resolvePromise, tab);
    } catch (error) {
      finish(rejectPromise, error);
    }
  };
  const fail = details => {
    if (
      details?.tabId !== tabId ||
      Number(details?.frameId ?? 0) !== 0 ||
      settled
    ) {
      return;
    }
    finish(
      rejectPromise,
      commandError(
        "NAVIGATION_FAILED",
        `Navigation failed for tab ${tabId}: ${String(details?.error || "unknown error")}.`,
        {
          tabId,
          url: details?.url ?? null,
          error: details?.error ?? null
        }
      )
    );
  };
  const add = (event, listener) => {
    if (event?.addListener && event?.removeListener) {
      event.addListener(listener);
      listeners.push([event, listener]);
    }
  };

  add(targetEvent, complete);
  add(chromeApi.webNavigation.onHistoryStateUpdated, complete);
  add(chromeApi.webNavigation.onReferenceFragmentUpdated, complete);
  add(chromeApi.webNavigation.onErrorOccurred, fail);
  timer = globalThis.setTimeout(
    () => finish(
      rejectPromise,
      commandError(
        "TAB_WAIT_TIMEOUT",
        `Timed out waiting for a new '${waitUntil}' navigation event in tab ${tabId}.`
      )
    ),
    Math.max(0, timeoutMs)
  );

  return {
    promise,
    cancel: cleanup
  };
}

export async function waitForTab(chromeApi, tabId, options = {}) {
  const waitUntil = String(options.waitUntil || "load").toLowerCase();
  const status = options.status == null
    ? (waitUntil === "commit" || waitUntil === "domcontentloaded"
      ? null
      : "complete")
    : String(options.status);
  const urlContains = options.urlContains == null
    ? null
    : String(options.urlContains);
  const urlPattern = options.urlPattern == null
    ? null
    : String(options.urlPattern);
  const timeoutMs = remainingCommandTimeout(options);

  const deadline = Date.now() + timeoutMs;
  do {
    assertCommandActive(options);
    const tab = await chromeApi.tabs.get(tabId);
    const url = String(tab?.url || "");
    const statusMatches = !status || tab?.status === status;
    const urlMatches =
      (urlContains == null || url.includes(urlContains)) &&
      (urlPattern == null || matchesUrlPattern(url, urlPattern));
    let documentMatches = true;
    if (waitUntil === "domcontentloaded") {
      documentMatches = await documentReady(chromeApi, tabId);
    }
    if (tab && statusMatches && urlMatches && documentMatches) {
      if (waitUntil === "networkidle") {
        await delayWithinDeadline(
          Math.max(100, Number(options.quietMs ?? 500)),
          options
        );
      }
      return await chromeApi.tabs.get(tabId);
    }
    await new Promise(resolve => globalThis.setTimeout(resolve, 100));
  } while (Date.now() <= deadline);

  throw commandError(
    "TAB_WAIT_TIMEOUT",
    `Timed out waiting for tab ${tabId} to reach '${waitUntil}'.`
  );
}

function remainingCommandTimeout(options) {
  const configured = Math.max(
    0,
    Number(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
  );
  const deadline = commandDeadline(options);
  if (deadline == null) {
    return configured;
  }
  return Math.max(0, Math.min(configured, deadline - Date.now()));
}

function matchesNavigationUrl(url, options) {
  const urlContains = options.urlContains == null
    ? null
    : String(options.urlContains);
  const urlPattern = options.urlPattern == null
    ? null
    : String(options.urlPattern);
  return (
    (urlContains == null || url.includes(urlContains)) &&
    (urlPattern == null || matchesUrlPattern(url, urlPattern))
  );
}

async function delayWithinDeadline(milliseconds, parameters) {
  const requested = Math.max(0, Number(milliseconds));
  const deadline = commandDeadline(parameters);
  const remaining = deadline != null
    ? deadline - Date.now()
    : requested;
  if (remaining <= 0) {
    assertCommandActive(parameters);
  }
  await new Promise(resolve => globalThis.setTimeout(
    resolve,
    Math.min(requested, Math.max(0, remaining))
  ));
  assertCommandActive(parameters);
}

async function documentReady(chromeApi, tabId) {
  try {
    const [result] = await chromeApi.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => document.readyState !== "loading"
    });
    return result?.result === true;
  } catch {
    return false;
  }
}

function matchesUrlPattern(url, pattern) {
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const end = pattern.lastIndexOf("/");
    try {
      return new RegExp(
        pattern.slice(1, end),
        pattern.slice(end + 1)
      ).test(url);
    } catch {
      return false;
    }
  }
  if (pattern.includes("*")) {
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    return new RegExp(`^${source}$`).test(url);
  }
  return url.includes(pattern);
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

function assertCommandActive(parameters) {
  const deadline = commandDeadline(parameters);
  if (deadline != null && deadline <= Date.now()) {
    throw commandError(
      "COMMAND_EXPIRED",
      "The browser command expired before a side effect could be performed.",
      { deadlineEpochMs: deadline }
    );
  }
}

function commandDeadline(parameters) {
  const raw = parameters?.commandDeadlineEpochMs;
  if (raw == null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function withQueueReleasingDeadline(execution, parameters, method) {
  const deadline = commandDeadline(parameters);
  if (deadline == null) {
    return execution;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    assertCommandActive(parameters);
  }

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(commandError(
        "COMMAND_TIMEOUT",
        `Read-only browser command '${method}' exceeded its deadline.`,
        {
          method,
          deadlineEpochMs: deadline
        }
      )),
      Math.max(0, remainingMs - COMMAND_RESPONSE_GRACE_MS)
    );
  });
  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer != null) {
      globalThis.clearTimeout(timer);
    }
  }
}

function screenshotImageOptions(parameters, format) {
  return {
    format,
    quality: format === "jpeg"
      ? Math.max(0, Math.min(100, Number(parameters.quality ?? 80)))
      : undefined
  };
}

function screenshotDataFromUrl(dataUrl) {
  if (typeof dataUrl !== "string") {
    throw commandError(
      "SCREENSHOT_DATA_INVALID",
      "captureVisibleTab returned no image data."
    );
  }
  const separator = dataUrl.indexOf(",");
  const header = separator >= 0 ? dataUrl.slice(0, separator) : "";
  const data = separator >= 0 ? dataUrl.slice(separator + 1) : "";
  if (!/^data:image\/(?:png|jpeg);base64$/i.test(header) || !data) {
    throw commandError(
      "SCREENSHOT_DATA_INVALID",
      "captureVisibleTab returned an unsupported image data URL."
    );
  }
  return data;
}

async function withScreenshotStageDeadline(
  execution,
  parameters,
  stage,
  tabId,
  timings
) {
  const deadline = screenshotDebuggerDeadline(parameters);
  if (deadline == null) {
    return execution;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw screenshotStageTimeout(stage, tabId, deadline, timings);
  }
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(screenshotStageTimeout(
        stage,
        tabId,
        deadline,
        timings
      )),
      remainingMs
    );
  });
  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer != null) {
      globalThis.clearTimeout(timer);
    }
  }
}

function screenshotDebuggerDeadline(parameters) {
  const deadline = commandDeadline(parameters);
  if (deadline == null) {
    return null;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return deadline;
  }
  const reserveMs = Math.min(
    SCREENSHOT_CLEANUP_RESERVE_MS,
    Math.max(1, Math.floor(remainingMs / 2))
  );
  return deadline - Math.max(
    reserveMs,
    Math.min(50, remainingMs)
  );
}

function screenshotStageTimeout(stage, tabId, deadlineEpochMs, timings) {
  return commandError(
    "SCREENSHOT_STAGE_TIMEOUT",
    `Browser screenshot stage '${stage}' exceeded its deadline.`,
    {
      screenshotStage: stage,
      tabId,
      deadlineEpochMs,
      screenshotTimings: { ...timings }
    }
  );
}

function isScreenshotDeadlineError(error) {
  return error?.code === "SCREENSHOT_STAGE_TIMEOUT" ||
    error?.code === "COMMAND_EXPIRED" ||
    error?.code === "COMMAND_TIMEOUT";
}

function addScreenshotErrorDetails(
  error,
  strategy,
  tabId,
  timings,
  fallbackReason = null
) {
  const normalized = error instanceof Error
    ? error
    : new Error(String(error));
  const details = normalized.details && typeof normalized.details === "object"
    ? normalized.details
    : {};
  normalized.details = {
    ...details,
    screenshotStrategy: strategy,
    tabId,
    fallbackReason,
    screenshotTimings: { ...timings }
  };
  if (!normalized.code) {
    normalized.code = "SCREENSHOT_CAPTURE_FAILED";
  }
  return normalized;
}

function isScriptablePageUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

async function resolveTabId(chromeApi, parameters, sessions) {
  if (Number.isInteger(parameters.index)) {
    if (parameters.sessionId != null) {
      const session = requireSession(sessions, parameters.sessionId);
      const tabId = (session.tabIds || [])[parameters.index];
      if (!Number.isInteger(tabId)) {
        throw commandError(
          "TAB_NOT_FOUND",
          `No session tab exists at index ${parameters.index}.`
        );
      }
      return tabId;
    }
    const tabs = await chromeApi.tabs.query({ currentWindow: true });
    const tab = tabs[parameters.index];
    if (!tab) {
      throw commandError("TAB_NOT_FOUND", `No tab exists at index ${parameters.index}.`);
    }
    return tab.id;
  }
  if (Number.isInteger(parameters.tabId)) {
    return parameters.tabId;
  }
  if (parameters.sessionId != null) {
    const session = requireSession(sessions, parameters.sessionId);
    if (Number.isInteger(session.tabId)) {
      return session.tabId;
    }
    throw commandError(
      "TAB_NOT_FOUND",
      `Session '${session.sessionId}' has no remaining browser tab.`
    );
  }
  const tabs = await chromeApi.tabs.query({ currentWindow: true });
  const active = tabs.find(tab => tab.active);
  if (!active) {
    throw commandError("TAB_NOT_FOUND", "No active tab was found.");
  }
  return active.id;
}

function normalizeTab(tab) {
  if (!tab) {
    return null;
  }
  return {
    ...tab,
    tabId: tab.id,
    url: tab.url ?? "",
    title: tab.title ?? ""
  };
}

function requireSession(sessions, value) {
  const sessionId = requireNonEmptyString(value, "sessionId");
  const session = sessions.get(sessionId);
  if (!session) {
    throw commandError("SESSION_NOT_ATTACHED", `Session '${sessionId}' is not attached.`);
  }
  return session;
}

function updateSessionTab(sessions, sessionId, tabId, addToOwnedTabs) {
  if (sessionId == null || !Number.isInteger(tabId)) {
    return;
  }
  const session = requireSession(sessions, sessionId);
  session.tabId = tabId;
  if (addToOwnedTabs && !(session.tabIds || []).includes(tabId)) {
    session.tabIds = [...(session.tabIds || []), tabId];
  }
}
