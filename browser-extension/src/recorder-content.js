(() => {
  if (window.__aivaneRecorderContentInstalled) {
    return;
  }
  window.__aivaneRecorderContentInstalled = true;

  if (!isRecordablePage()) {
    return;
  }

  const pendingInputs = new Map();
  const lastSentValues = new Map();
  const MAX_DOM_CHARS = 60000;
  const MAX_VISIBLE_TEXT_CHARS = 20000;
  const MAX_LOCAL_DOM_CHARS = 5000;

  function send(event) {
    try {
      const result = chrome.runtime.sendMessage({
        type: "aivane.recorder.event",
        event: {
          timestamp: new Date().toISOString(),
          url: location.href,
          title: document.title,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1
          },
          ...event
        }
      });
      if (result?.catch) {
        void result.catch(() => {});
      }
    } catch {
      // Recorder may have just stopped.
    }
  }

  function describeTarget(element) {
    if (!(element instanceof Element)) {
      return {};
    }
    const bounds = element.getBoundingClientRect();
    const label = labelFor(element);
    const accessibleName = firstNonBlank(
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      label,
      visibleText(element)
    );
    const selectorCandidates = selectorCandidatesFor(element);
    return {
      selector: selectorCandidates[0] || "",
      selectorCandidates,
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      name: element.getAttribute("name") || "",
      inputType: element.getAttribute("type") || "",
      role: roleFor(element),
      label,
      accessibleName,
      attributes: selectedAttributes(element),
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      },
      disabled: Boolean(element.disabled),
      required: Boolean(element.required)
    };
  }

  function eventEvidence(element) {
    const target = describeTarget(element);
    return {
      target,
      snapshot: pageSnapshot(element, target)
    };
  }

  function scheduleInput(element) {
    if (isPasswordField(element)) return;
    const selector = selectorFor(element);
    pendingInputs.set(selector, { element });
  }

  function flushInput(selector) {
    const entry = pendingInputs.get(selector);
    if (!entry) {
      return;
    }
    pendingInputs.delete(selector);
    const element = entry.element;
    if (isPasswordField(element)) return;
    const value = editableValue(element);
    if (lastSentValues.get(selector) === stableValue(value)) {
      return;
    }
    lastSentValues.set(selector, stableValue(value));
    send({
      type: "fill",
      value,
      ...eventEvidence(element)
    });
  }

  function flushInputs() {
    for (const selector of [...pendingInputs.keys()]) {
      flushInput(selector);
    }
  }

  document.addEventListener("input", event => {
    const element = editableElement(event.target);
    if (element) {
      scheduleInput(element);
    }
  }, true);

  document.addEventListener("focusout", event => {
    const element = editableElement(event.target);
    if (!element || isPasswordField(element)) {
      return;
    }
    const selector = selectorFor(element);
    if (pendingInputs.has(selector)) {
      flushInput(selector);
    }
  }, true);

  document.addEventListener("change", event => {
    const element = editableElement(event.target);
    if (!element) {
      return;
    }
    const selector = selectorFor(element);
    if (pendingInputs.has(selector)) {
      flushInput(selector);
    }
    if (element instanceof HTMLInputElement && element.type === "file") {
      send({
        type: "upload",
        files: Array.from(element.files || []).map(file => ({
          name: file.name,
          size: file.size,
          type: file.type
        })),
        ...eventEvidence(element)
      });
      return;
    }
    if (element instanceof HTMLSelectElement) {
      const value = editableValue(element);
      if (lastSentValues.get(selector) === stableValue(value)) {
        return;
      }
      lastSentValues.set(selector, stableValue(value));
      send({
        type: "select",
        value,
        selectedText: Array.from(element.selectedOptions || [])
          .map(option => option.textContent?.trim() || "")
          .filter(Boolean),
        ...eventEvidence(element)
      });
      return;
    }
    const value = editableValue(element);
    if (lastSentValues.get(selector) === stableValue(value)) {
      return;
    }
    lastSentValues.set(selector, stableValue(value));
    send({
      type: "fill",
      value,
      ...eventEvidence(element)
    });
  }, true);

  // A click is only worth a picture while the control it lands on is still on
  // screen. Menus close and dropdowns collapse the moment the click is
  // handled, so the screenshot has to be started when the pointer goes down —
  // before the page reacts — rather than after the click has been reported.
  // The id ties that early frame to the click event it belongs to.
  const gestureToken = Math.random().toString(36).slice(2);
  let gestureCount = 0;
  let pendingGestureId = "";

  document.addEventListener("pointerdown", () => {
    pendingGestureId = `${gestureToken}-${++gestureCount}`;
    try {
      const result = chrome.runtime.sendMessage({
        type: "aivane.recorder.prepare",
        gestureId: pendingGestureId
      });
      if (result?.catch) {
        void result.catch(() => {});
      }
    } catch {
      // Recorder may have just stopped.
    }
  }, true);

  document.addEventListener("click", event => {
    // A click the page synthesised has no gesture of its own, and the frame
    // from the previous one no longer shows the control it lands on.
    const gestureId = pendingGestureId;
    pendingGestureId = "";
    flushInputs();
    const element = event.target instanceof Element
      ? event.target.closest("button, a, input, select, textarea, [role]")
        || event.target
      : null;
    if (!element) {
      return;
    }
    send({
      type: "click",
      gestureId,
      point: {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      },
      button: event.button,
      modifiers: modifiersFor(event),
      ...eventEvidence(element)
    });
  }, true);

  document.addEventListener("keydown", event => {
    if (!isRecordedKey(event) || isPasswordField(event.target)) {
      return;
    }
    flushInputs();
    const element = event.target instanceof Element ? event.target : null;
    send({
      type: "key",
      key: event.key,
      code: event.code,
      modifiers: modifiersFor(event),
      ...eventEvidence(element)
    });
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "aivane.recorder.flush") {
      flushInputs();
      if (typeof sendResponse === "function") sendResponse({ flushed: true });
    }
  });

  function pageSnapshot(element, target) {
    const clone = document.documentElement?.cloneNode(true);
    if (clone instanceof Element) {
      clone.querySelectorAll(
        "script, style, noscript, svg, canvas, iframe, template"
      ).forEach(node => node.remove());
      stripPasswordValues(clone);
    }
    return {
      url: location.href,
      title: document.title,
      html: truncate(clone?.outerHTML || "", MAX_DOM_CHARS),
      visibleText: truncate(
        String(document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .trim(),
        MAX_VISIBLE_TEXT_CHARS
      ),
      targetLocalDom: truncate(
        sanitizedLocalDom(element),
        MAX_LOCAL_DOM_CHARS
      ),
      accessibility: {
        title: document.title,
        language: document.documentElement?.lang || "",
        target: {
          role: target.role || "generic",
          name: target.accessibleName || "",
          disabled: target.disabled === true,
          required: target.required === true
        },
        controls: Array.from(
          document.querySelectorAll(
            "input, select, textarea, button, a[href], [role]"
          )
        ).slice(0, 200).map(describeTarget)
      },
      successSelector: successSelector()
    };
  }

  function editableElement(value) {
    if (!(value instanceof Element) || isPasswordField(value)) {
      return null;
    }
    if (
      value instanceof HTMLInputElement
      || value instanceof HTMLTextAreaElement
      || value instanceof HTMLSelectElement
      || value.isContentEditable
    ) {
      return value;
    }
    return null;
  }

  function editableValue(element) {
    if (isPasswordField(element)) return "";
    if (element instanceof HTMLInputElement) {
      if (element.type === "file") {
        return "";
      }
      if (element.type === "checkbox" || element.type === "radio") {
        return element.checked;
      }
      return element.value;
    }
    if (
      element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement
    ) {
      return element.value;
    }
    return element?.textContent || "";
  }

  function isPasswordField(element) {
    return element instanceof HTMLInputElement && (
      element.type.toLowerCase() === "password"
      || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(element.getAttribute("autocomplete") || "")
    );
  }

  function stripPasswordValues(root) {
    for (const input of [root, ...root.querySelectorAll("input")]) {
      if (!isPasswordField(input)) continue;
      input.removeAttribute("value");
      input.value = "";
    }
  }

  function sanitizedLocalDom(element) {
    if (!(element instanceof Element)) return "";
    const clone = element.cloneNode(true);
    stripPasswordValues(clone);
    return clone.outerHTML || "";
  }

  function stableValue(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function modifiersFor(event) {
    return {
      alt: event.altKey === true,
      ctrl: event.ctrlKey === true,
      meta: event.metaKey === true,
      shift: event.shiftKey === true
    };
  }

  function isRecordedKey(event) {
    if (event.isComposing || event.repeat) {
      return false;
    }
    return [
      "Enter",
      "Escape",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
      "Home",
      "End"
    ].includes(event.key);
  }

  // Attributes a page author wrote, in the order they survive a redeploy. A
  // test hook exists to be automated against, a form control name is part of
  // the submitted payload, and an accessible label is part of the product.
  const STABLE_ATTRIBUTES = [
    "data-testid",
    "data-test",
    "data-qa",
    "name",
    "aria-label",
    "placeholder"
  ];
  // Ids a framework minted for one render: Lightning's input-760, Ember's
  // ember123, React's :r3:. Unique today and gone on the next page load.
  const GENERATED_ID = /\d{3,}|^:|^(?:ember|yui|aura|slds)\d/i;
  const MAX_TEXT_LOCATOR_LENGTH = 60;
  // The controls a recorded click can land on. Scoping a text match to them
  // keeps it fast, and keeps it working when the tag changes: the button this
  // recorder captured as an <a> was a <button> the next day.
  const INTERACTIVE_SCOPE =
    'a,button,[role="button"],[role="link"],'
    + '[role="menuitem"],[role="option"],[role="tab"]';

  /**
   * Ranks every way this element can be named, best first.
   *
   * Preferring `#id` was wrong on any framework that numbers its ids. A
   * recording of Salesforce captured #combobox-button-756 and #input-760, and
   * replaying it the next day matched nothing, because Lightning had
   * renumbered them all. The same elements carried name="salutation" and
   * aria-label="Account Name" the whole time.
   *
   * Every candidate is resolved against the live page before it is kept, using
   * the same rules the automation will use later, so a locator that is already
   * ambiguous never reaches a template. Only the fallbacks are kept unverified,
   * because something has to be recorded.
   */
  function selectorCandidatesFor(element) {
    const candidates = [];
    const tag = element.tagName.toLowerCase();
    const add = candidate => {
      if (candidate && !candidates.includes(candidate) && matchesOne(candidate)) {
        candidates.push(candidate);
      }
    };
    for (const attribute of STABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) {
        add(`${tag}[${attribute}="${attributeEscape(value)}"]`);
      }
    }
    if (element.id && !GENERATED_ID.test(element.id)) {
      add(`#${cssEscape(element.id)}`);
    }
    const name = firstNonBlank(
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      labelFor(element),
      visibleText(element)
    );
    if (name && name.length <= MAX_TEXT_LOCATOR_LENGTH) {
      // A component-library tag scopes the text without pinning the markup
      // around the control, which is the part that changes.
      add(`${tag.includes("-") ? tag : INTERACTIVE_SCOPE}`
        + `:text-is("${attributeEscape(name)}"):visible`);
    }
    const positional = positionalSelector(element);
    if (positional && !candidates.includes(positional)) {
      candidates.push(positional);
    }
    const identifier = element.id ? `#${cssEscape(element.id)}` : "";
    if (identifier && !candidates.includes(identifier)) {
      // A generated id is still the fastest way to find this element right
      // now, so it stays as evidence, last.
      candidates.push(identifier);
    }
    return candidates;
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    return selectorCandidatesFor(element)[0] || "";
  }

  function positionalSelector(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children)
          .filter(sibling => sibling.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (isUnique(candidate)) {
        return candidate;
      }
      current = parent;
    }
    return parts.join(" > ");
  }

  /**
   * Resolves a candidate the way the automation will, and reports whether it
   * names exactly one element. `text=` and `:has-text()` are not CSS, so they
   * cannot be handed to querySelectorAll.
   */
  function matchesOne(candidate) {
    try {
      const scopedText = candidate.match(
        /^(.+?):(text-is|has-text)\("(.*)"\)(:visible)?$/s);
      if (scopedText) {
        return textMatches(
          scopedText[1],
          unescapeQuoted(scopedText[3]),
          scopedText[2] === "text-is"
        ).length === 1;
      }
      const exactText = candidate.match(/^text="(.*)"$/s);
      if (exactText) {
        return textMatches(null, unescapeQuoted(exactText[1]), true).length === 1;
      }
      return document.querySelectorAll(candidate).length === 1;
    } catch {
      return false;
    }
  }

  function textMatches(scopeSelector, expected, exact) {
    const wanted = normalizeSpace(expected);
    const scope = scopeSelector
      ? Array.from(document.querySelectorAll(scopeSelector))
      : Array.from(document.querySelectorAll("body *"));
    const matched = scope.filter(candidate => {
      const actual = normalizeSpace(candidate.innerText ?? candidate.textContent ?? "");
      return exact ? actual === wanted : actual.includes(wanted);
    });
    const innermost = scopeSelector
      ? matched
      : matched.filter(candidate => !Array.from(candidate.children || []).some(child => {
          const childText = normalizeSpace(child.innerText ?? child.textContent ?? "");
          return exact ? childText === wanted : childText.includes(wanted);
        }));
    return innermost.filter(isDisplayed);
  }

  function isDisplayed(element) {
    const style = globalThis.getComputedStyle(element);
    if (
      style.display === "none"
      || style.visibility === "hidden"
      || Number(style.opacity) === 0
    ) {
      return false;
    }
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  }

  function normalizeSpace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function unescapeQuoted(value) {
    return String(value).replace(/\\(["\\])/g, "$1");
  }

  function labelFor(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element.id) {
      const direct = document.querySelector(
        `label[for="${attributeEscape(element.id)}"]`
      );
      if (direct) {
        return visibleText(direct);
      }
    }
    const wrapping = element.closest("label");
    if (wrapping) {
      return visibleText(wrapping);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(visibleText)
        .join(" ");
    }
    return "";
  }

  function roleFor(element) {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      if (element.type === "submit" || element.type === "button") return "button";
      return "textbox";
    }
    if (tag === "form") return "form";
    return "generic";
  }

  function selectedAttributes(element) {
    const result = {};
    for (const name of [
      "id",
      "name",
      "type",
      "placeholder",
      "aria-label",
      "aria-labelledby",
      "data-testid",
      "data-test",
      "data-qa"
    ]) {
      const value = element.getAttribute(name);
      if (value != null) {
        result[name] = value;
      }
    }
    return result;
  }

  function successSelector() {
    if (document.querySelector("[data-aivane-submission-success]")) {
      return "[data-aivane-submission-success=\"true\"]";
    }
    return "";
  }

  function visibleText(element) {
    return truncate(
      String(element?.innerText || element?.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      180
    );
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function cssEscape(value) {
    return globalThis.CSS?.escape
      ? globalThis.CSS.escape(String(value))
      : String(value).replace(/[^A-Za-z0-9_-]/g, character => `\\${character}`);
  }

  function attributeEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function truncate(value, maximum) {
    const text = String(value || "");
    return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
  }

  function firstNonBlank(...values) {
    for (const value of values) {
      if (value != null && String(value).trim()) {
        return String(value).trim();
      }
    }
    return "";
  }

  function isRecordablePage() {
    if (!/^https?:$/i.test(location.protocol)) {
      return false;
    }
    const localRecorder = ["127.0.0.1", "localhost"].includes(location.hostname)
      && location.pathname.startsWith("/recorder/")
      && !location.pathname.startsWith("/recorder/test/");
    return !localRecorder;
  }
})();
