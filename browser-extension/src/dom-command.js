/**
 * Executes one DOM command inside chrome.scripting's ISOLATED world.
 *
 * Keep this function self-contained. Chrome serializes the function body before
 * injecting it, so it cannot close over other extension module bindings.
 */
export async function executeDomCommand(command) {
  const input = command && typeof command === "object" ? command : {};
  const action = String(input.action || "");
  const parameters = input.parameters && typeof input.parameters === "object"
    ? input.parameters
    : {};

  const sleep = milliseconds =>
    new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
  const commandDeadlineEpochMs = parameters.commandDeadlineEpochMs == null
    ? null
    : Number(parameters.commandDeadlineEpochMs);
  const assertCommandActive = () => {
    if (
      Number.isFinite(commandDeadlineEpochMs) &&
      commandDeadlineEpochMs <= Date.now()
    ) {
      const error = new Error("The browser command expired before DOM execution.");
      error.code = "COMMAND_EXPIRED";
      throw error;
    }
  };

  const requireLocator = value => {
    if (typeof value === "string" && value.trim()) {
      return { strategy: "css", value: value.trim(), index: 0 };
    }
    if (!value || typeof value !== "object") {
      throw new TypeError("locator must be a CSS string or locator object.");
    }
    const strategy = String(value.strategy || "css").toLowerCase();
    const locatorValue = String(value.value || value.selector || "").trim();
    const index = value.index == null ? 0 : Number(value.index);
    if (!["css", "xpath", "text"].includes(strategy)) {
      throw new TypeError("locator.strategy must be 'css', 'xpath', or 'text'.");
    }
    if (!locatorValue) {
      throw new TypeError("locator.value must be a non-empty string.");
    }
    if (!Number.isInteger(index)) {
      throw new TypeError("locator.index must be an integer.");
    }
    return {
      strategy,
      value: locatorValue,
      index,
      exact: value.exact === true,
      visibleOnly: value.visibleOnly === true,
      hasText: value.hasText == null ? null : String(value.hasText),
      descendantSelector: value.descendantSelector == null
        ? null
        : String(value.descendantSelector)
    };
  };

  const resolveAll = locatorInput => {
    const locator = requireLocator(locatorInput);
    let results;
    if (locator.strategy === "css") {
      if (locator.hasText != null) {
        const expected = normalizeText(locator.hasText);
        const ancestors = Array.from(document.querySelectorAll(locator.value))
          .filter(element => {
            const actual = normalizeText(textOf(element));
            return locator.exact ? actual === expected : actual.includes(expected);
          });
        results = locator.descendantSelector
          ? ancestors.flatMap(element =>
              Array.from(element.querySelectorAll(
                relativeSelector(locator.descendantSelector)
              )))
          : ancestors;
      } else {
        results = Array.from(document.querySelectorAll(locator.value));
      }
    } else if (locator.strategy === "text") {
      // Walking text nodes visits the handful of elements that own visible
      // text instead of every element in the document, and reads innerText
      // only for those. Reading it for all of them forced a layout per node,
      // which on a real application page took long enough that the command
      // timed out before the element was ever found.
      const expected = normalizeText(locator.value);
      const matches = [];
      const visited = new Set();
      const walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const owner = node.parentElement;
        if (!owner || visited.has(owner)) {
          continue;
        }
        visited.add(owner);
        const actual = normalizeText(textOf(owner));
        if (locator.exact ? actual === expected : actual.includes(expected)) {
          matches.push(owner);
        }
      }
      // The element that owns the text is already the innermost one, but a
      // wrapper whose only child holds the text owns it too when the markup
      // puts them in the same node.
      results = matches.filter(element =>
        !Array.from(element.children || []).some(child => {
          const childText = normalizeText(textOf(child));
          return locator.exact
            ? childText === expected
            : childText.includes(expected);
        })
      );
    } else {
      const snapshot = document.evaluate(
        locator.value,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      results = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const item = snapshot.snapshotItem(index);
        if (item && item.nodeType === Node.ELEMENT_NODE) {
          results.push(item);
        }
      }
    }
    if (locator.visibleOnly) {
      results = results.filter(isVisible);
    }
    return Array.from(new Set(results));
  };

  const resolveOne = locatorInput => {
    const locator = requireLocator(locatorInput);
    const matches = resolveAll(locator);
    const index = locator.index < 0
      ? matches.length + locator.index
      : locator.index;
    return matches[index] ?? null;
  };

  const isVisible = element => {
    if (!element || !element.isConnected) {
      return false;
    }
    const style = globalThis.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  };

  const isEnabled = element =>
    Boolean(
      element &&
      !element.disabled &&
      element.getAttribute?.("aria-disabled") !== "true"
    );

  const textOf = element => {
    if (!element) {
      return null;
    }
    const text = typeof element.innerText === "string"
      ? element.innerText
      : element.textContent;
    return text == null ? "" : String(text);
  };

  const normalizeText = value =>
    String(value ?? "").replace(/\s+/g, " ").trim();

  const relativeSelector = value => {
    const selector = String(value || "").trim();
    return /^[>+~]/.test(selector) ? `:scope ${selector}` : selector;
  };

  const serializeElement = element => {
    if (!element) {
      return null;
    }
    const rectangle = element.getBoundingClientRect();
    const attributes = {};
    for (const attribute of Array.from(element.attributes || [])) {
      attributes[attribute.name] = attribute.value;
    }
    return {
      tagName: String(element.tagName || "").toLowerCase(),
      text: textOf(element),
      value: "value" in element ? element.value : null,
      attributes,
      attached: Boolean(element.isConnected),
      visible: isVisible(element),
      enabled: isEnabled(element),
      selected: Boolean(element.selected),
      checked: Boolean(element.checked),
      innerHTML: element.innerHTML ?? null,
      outerHTML: element.outerHTML ?? null,
      bounds: {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height
      },
      rectangle: {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height
      }
    };
  };

  const requireElement = locator => {
    const element = resolveOne(locator);
    if (!element) {
      const error = new Error("The target element was not found.");
      error.code = "ELEMENT_NOT_FOUND";
      throw error;
    }
    return element;
  };

  const dispatch = (element, eventName, init = {}) => {
    const event = new Event(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init
    });
    element.dispatchEvent(event);
  };

  const assignValue = (element, value) => {
    const text = String(value ?? "");
    if (element.isContentEditable) {
      element.textContent = text;
      return text;
    }
    if (!("value" in element)) {
      throw new TypeError("The target element does not accept text input.");
    }
    const prototype = Object.getPrototypeOf(element);
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")
      : null;
    if (descriptor?.set) {
      descriptor.set.call(element, text);
    } else {
      element.value = text;
    }
    return text;
  };

  const elementStateMatches = (element, state) => {
    switch (state) {
      case "attached":
        return Boolean(element?.isConnected);
      case "detached":
        return !element?.isConnected;
      case "visible":
        return isVisible(element);
      case "hidden":
        return !element || !isVisible(element);
      case "enabled":
        return isVisible(element) && isEnabled(element);
      case "disabled":
        return Boolean(element) && !isEnabled(element);
      default:
        throw new TypeError(
          "state must be attached, detached, visible, hidden, enabled, or disabled."
        );
    }
  };

  switch (action) {
    case "get":
    case "query":
      return serializeElement(resolveOne(parameters.locator));

    case "getAll":
    case "queryAll": {
      const limit = Math.max(0, Math.min(Number(parameters.limit ?? 1000), 1000));
      return resolveAll(parameters.locator).slice(0, limit).map(serializeElement);
    }

    case "getText":
      return textOf(requireElement(parameters.locator));

    case "getAttribute": {
      const name = String(parameters.name || "").trim();
      if (!name) {
        throw new TypeError("name must be a non-empty attribute name.");
      }
      const element = requireElement(parameters.locator);
      if (name.toLowerCase() === "value" && "value" in element) {
        return element.value;
      }
      return element.getAttribute(name);
    }

    case "getEditableValue": {
      const element = requireElement(parameters.locator);
      if ("value" in element) {
        return String(element.value ?? "");
      }
      if (element.isContentEditable) {
        return String(element.textContent ?? "");
      }
      throw new TypeError("The target element does not expose an editable value.");
    }

    case "preparePointer": {
      const element = requireElement(parameters.locator);
      let rectangle = element.getBoundingClientRect();
      const viewportWidth =
        globalThis.innerWidth || document.documentElement?.clientWidth || 0;
      const viewportHeight =
        globalThis.innerHeight || document.documentElement?.clientHeight || 0;
      const centerX = rectangle.left + rectangle.width / 2;
      const centerY = rectangle.top + rectangle.height / 2;
      const hitElement = typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(centerX, centerY)
        : null;
      const centerIsClickable =
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        centerX >= 0 &&
        centerY >= 0 &&
        centerX <= viewportWidth &&
        centerY <= viewportHeight &&
        (
          hitElement == null ||
          hitElement === element ||
          element.contains(hitElement)
        );
      if (!centerIsClickable) {
        element.scrollIntoView({
          block: parameters.block || "center",
          inline: parameters.inline || "center",
          behavior: "auto"
        });
        // Sticky product panels can reposition after scrollIntoView. Wait for
        // layout to settle before returning the debugger click coordinates.
        await sleep(50);
        rectangle = element.getBoundingClientRect();
      }
      if (!isVisible(element)) {
        const error = new Error("The target element is not visible.");
        error.code = "ELEMENT_NOT_VISIBLE";
        throw error;
      }
      return {
        point: {
          x: rectangle.left + rectangle.width / 2,
          y: rectangle.top + rectangle.height / 2
        },
        element: serializeElement(element)
      };
    }

    case "click": {
      const element = requireElement(parameters.locator);
      element.scrollIntoView({
        block: parameters.block || "center",
        inline: parameters.inline || "center",
        behavior: "auto"
      });
      element.focus?.({ preventScroll: true });
      assertCommandActive();
      element.click();
      return { clicked: true, element: serializeElement(element) };
    }

    case "input": {
      const element = requireElement(parameters.locator);
      element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      element.focus?.({ preventScroll: true });
      const requested = String(parameters.text ?? parameters.value ?? "");
      const existing = "value" in element
        ? String(element.value ?? "")
        : String(element.textContent ?? "");
      assertCommandActive();
      const text = assignValue(
        element,
        parameters.clear === false ? existing + requested : requested
      );
      dispatch(element, "input");
      if (parameters.commit !== false) {
        dispatch(element, "change");
      }
      return { input: true, value: text };
    }

    case "select": {
      const element = requireElement(parameters.locator);
      if (String(element.tagName || "").toLowerCase() !== "select") {
        throw new TypeError("The target element is not a select element.");
      }
      const requested = Array.isArray(parameters.values)
        ? parameters.values.map(String)
        : [String(parameters.value ?? "")];
      const selected = [];
      assertCommandActive();
      for (const option of Array.from(element.options || [])) {
        option.selected = requested.includes(String(option.value));
        if (option.selected) {
          selected.push(String(option.value));
        }
      }
      dispatch(element, "input");
      dispatch(element, "change");
      return { selected };
    }

    case "hover": {
      const element = requireElement(parameters.locator);
      element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      for (const eventName of ["mouseover", "mouseenter", "mousemove"]) {
        assertCommandActive();
        const event = new MouseEvent(eventName, {
          bubbles: eventName !== "mouseenter",
          cancelable: true,
          composed: true,
          view: globalThis.window
        });
        element.dispatchEvent(event);
      }
      return { hovered: true, element: serializeElement(element) };
    }

    case "wait": {
      const state = String(parameters.state || "visible");
      const timeoutMs = Math.max(0, Number(parameters.timeoutMs ?? 30000));
      const pollIntervalMs = Math.max(
        25,
        Math.min(Number(parameters.pollIntervalMs ?? 100), 1000)
      );
      const timeoutDeadline = Date.now() + timeoutMs;
      const deadline = Number.isFinite(commandDeadlineEpochMs)
        ? Math.min(timeoutDeadline, commandDeadlineEpochMs)
        : timeoutDeadline;
      do {
        assertCommandActive();
        const element = resolveOne(parameters.locator);
        if (elementStateMatches(element, state)) {
          return {
            matched: true,
            state,
            element: serializeElement(element)
          };
        }
        await sleep(pollIntervalMs);
      } while (Date.now() <= deadline);

      const error = new Error(`Timed out waiting for element state '${state}'.`);
      error.code = "ELEMENT_WAIT_TIMEOUT";
      throw error;
    }

    default:
      throw new TypeError(`Unsupported DOM action: ${action || "<empty>"}.`);
  }
}
