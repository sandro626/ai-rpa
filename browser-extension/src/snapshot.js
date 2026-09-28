export async function captureSnapshot(chromeApi, parameters) {
  const tabId = requireInteger(parameters.tabId, "tabId");

  // 冻结标签页防御(p-pilot 补丁,2026-09-27 真机:后台标签被 Chrome Memory
  // Saver 冻结时 scripting.executeScript 挂死无回调 → 桥侧 30s COMMAND_TIMEOUT,
  // 任务 0 步启动失败)。先激活解冻再注入;注入自带 10s 限时,超时重激活重试
  // 一次,仍不行为明确错误码(sidecar 拿到可诊断原因,不再是干等超时)。
  const activateTab = async () => {
    try {
      await chromeApi.tabs.update(tabId, { active: true });
      return true;
    } catch (error) {
      return false;
    }
  };
  const injectWithTimeout = async timeoutMs => {
    const target = { tabId };
    if (Number.isInteger(parameters.frameId)) {
      target.frameIds = [parameters.frameId];
    }
    const injection = chromeApi.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: captureDocumentSnapshot,
      args: [{
        locator: parameters.locator ?? null,
        maxNodes: Math.max(1, Math.min(Number(parameters.maxNodes ?? 2000), 10000))
      }]
    });
    let timer;
    try {
      return await Promise.race([
        injection,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(commandError("SCRIPT_EXEC_TIMEOUT",
              "Snapshot injection timed out (frozen or busy tab).")),
            timeoutMs
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  await activateTab();
  let executions;
  try {
    executions = await injectWithTimeout(10000);
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 500));
    await activateTab();
    executions = await injectWithTimeout(10000);
  }
  const execution = Array.isArray(executions) ? executions[0] : executions;
  if (!execution) {
    throw commandError("NO_SCRIPT_RESULT", "Snapshot capture returned no result.");
  }
  return execution.result;
}

/**
 * Self-contained because Chrome serializes this function for isolated-world
 * execution.
 */
export function captureDocumentSnapshot(options = {}) {
  const cssEscape = value => {
    if (globalThis.CSS?.escape) {
      return globalThis.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, character =>
      `\\${character.codePointAt(0).toString(16)} `);
  };
  const resolveRoot = locator => {
    if (!locator) {
      return document.body || document.documentElement;
    }
    const value = String(locator.value || locator.selector || "");
    const index = Number(locator.index ?? 0);
    if (String(locator.strategy || "css").toLowerCase() === "xpath") {
      const snapshot = document.evaluate(
        value,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      return snapshot.snapshotItem(index);
    }
    return document.querySelectorAll(value)[index] ?? null;
  };
  // 可点击自定义控件补名(p-pilot 补丁,受管模式 2026-09-19 同款启发式):
  // vben/ElementPlus 类 SPA 的按钮/下拉/表格操作列是纯 div/li/span,无 role
  // 无 aria → 快照里只剩无名 group,p-pilot 的 LLM 看不见「学校切换」这类
  // 顶栏控件(2026-09-27 真机实证,任务 16+ 步滚动找不到)。三路信号:显式
  // 交互属性、交互 class、cursor 样式。名字随 role 自动补齐(nameOf 的 role
  // 分支会取 innerText)。
  const looksClickable = element => {
    if (element.hasAttribute("onclick") || element.getAttribute("tabindex") === "0") {
      return true;
    }
    if (/(?:^|[\s_-])(?:btn|button)(?:[\s_-]|$)|clickable|pointer/i.test(
      String(element.getAttribute("class") || "")
    )) {
      return true;
    }
    try {
      return globalThis.getComputedStyle(element).cursor === "pointer";
    } catch (error) {
      return false;
    }
  };
  const roleOf = element => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const mapped = ({
      A: "link",
      BUTTON: "button",
      INPUT: element.type === "checkbox" ? "checkbox" : "textbox",
      SELECT: "combobox",
      TEXTAREA: "textbox",
      IMG: "img"
    })[element.tagName];
    if (mapped) {
      return mapped;
    }
    if (
      looksClickable(element) &&
      !element.querySelector("button, a, input, select, textarea, [role]")
    ) {
      return "button";
    }
    return null;
  };
  const textOf = element =>
    (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160);
  /**
   * A container is not named by everything inside it. Taking its text
   * repeated the same sentence at every level of a Lightning page - one
   * gridcell's label was restated by nine ancestors - which is what a reader
   * has to wade through to find the control that matters. Text still names
   * the elements that own it: anything with a role, and any leaf.
   */
  // checkbox 就近标签(p-pilot 补丁 2026-09-28:el-checkbox 的文字在兄弟/包装层
  // 《用户服务协议》按钮上,input 自身无名 → 代填的协议勾选误点链接按钮弹窗)
  const closestLabelOf = element => {
    const holder = element.closest("label, .el-checkbox, [class*='checkbox'], [class*='Checkbox']");
    return holder ? textOf(holder).slice(0, 60) : "";
  };
  const nameOf = (element, role) =>
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    // placeholder 兜底(p-pilot 补丁 2026-09-28:vben/Element Plus 输入框标签
    // 只放 placeholder,不读则密码框无名 → 登录检测/凭据代填/LLM 识别三链齐断)
    element.getAttribute("placeholder") ||
    element.getAttribute("aria-placeholder") ||
    (element.tagName === "INPUT" && element.type === "checkbox"
      ? closestLabelOf(element)
      : "") ||
    (role || !element.firstElementChild ? textOf(element) : "");
  /**
   * Where an element stands in the accessibility tree, in one pass over the
   * two things that cost the walk: its computed style and its box.
   *
   * <p>{@code reject} takes the subtree with it. A hidden container hides
   * its children too, and an icon is one node to a reader and a few dozen to
   * a DOM walker: the drawing instructions inside an {@code <svg>} took 22%
   * of the node budget of a captured page. What a screen reader ignores,
   * this ignores.
   *
   * <p>{@code skip} drops only the element. A {@code display: contents}
   * wrapper has no box of its own and real content underneath it.
   */
  const inspect = element => {
    if (element.ownerSVGElement) {
      return "reject";
    }
    if (
      element.getAttribute("aria-hidden") === "true" ||
      element.hasAttribute("inert") ||
      element.hasAttribute("hidden")
    ) {
      return "reject";
    }
    const style = globalThis.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return "reject";
    }
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0 ? "accept" : "skip";
  };
  const selectorOf = element => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (current.id) {
        parts.unshift(`#${cssEscape(current.id)}`);
        break;
      }
      let part = current.tagName.toLowerCase();
      if (current.parentElement) {
        const sameTagSiblings = Array.from(current.parentElement.children)
          .filter(candidate => candidate.tagName === current.tagName);
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return {
      selector: parts.join(" > "),
      nth: 0
    };
  };

  const root = resolveRoot(options.locator);
  if (!root) {
    const error = new Error("The snapshot root element was not found.");
    error.code = "ELEMENT_NOT_FOUND";
    throw error;
  }

  const maxNodes = Number(options.maxNodes || 2000);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(element) {
      const verdict = inspect(element);
      if (verdict === "reject") {
        return NodeFilter.FILTER_REJECT;
      }
      return verdict === "accept"
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });
  const refs = {};
  const lines = [];
  let count = 0;
  // The walker filters everything it returns, so the root is the only node
  // whose standing has to be judged here.
  let current = inspect(root) === "accept" ? root : walker.nextNode();
  while (current && count < maxNodes) {
    const ref = `e${count + 1}`;
    const role = roleOf(current);
    const name = nameOf(current, role);
    const target = selectorOf(current);
    let depth = 0;
    for (let parent = current.parentElement; parent && parent !== root; parent = parent.parentElement) {
      depth += 1;
    }
    const escapedName = String(name || "")
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    const attributes = [
      current.id ? `id="${current.id.replaceAll('"', '\\"')}"` : "",
      current.getAttribute("name")
        ? `name="${current.getAttribute("name").replaceAll('"', '\\"')}"`
        : ""
    ].filter(Boolean);
    lines.push(
      `${"  ".repeat(depth)}- ${role || current.tagName.toLowerCase()}`
        + `${escapedName ? ` "${escapedName}"` : ""}`
        + ` [ref=${ref}]`
        + `${attributes.length ? ` [${attributes.join(" ")}]` : ""}`
    );
    refs[ref] = {
      selector: target.selector,
      role,
      name,
      nth: target.nth,
      tagName: current.tagName.toLowerCase(),
      id: current.id || null,
      nameAttr: current.getAttribute("name")
    };
    count += 1;
    current = walker.nextNode();
  }
  if (current) {
    // Evidence that stops early has to say so. Eighteen captures of a failed
    // run were byte-identical because each one ran out of budget in the same
    // page shell, and nothing in the file said the modal being filled in was
    // missing rather than absent.
    lines.push(`- [truncated after ${count} nodes; the page has more]`);
  }
  return {
    tree: lines.join("\n"),
    refs,
    url: location.href,
    title: document.title,
    truncated: Boolean(current),
    nodeCount: count
  };
}

function requireInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw commandError("INVALID_ARGUMENT", `${name} must be an integer.`);
  }
  return value;
}

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
