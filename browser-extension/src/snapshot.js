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
  // 无 aria → 快照里只剩无名 group,LLM 看不见「学校切换」这类顶栏控件
  // (2026-09-27 真机实证)。三路信号:显式交互属性、交互 class、cursor 样式。
  // 名字随 role 自动补齐(nameOf 的 role 分支会取 innerText)。
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
    // el-switch 等自定义开关:role 属性或 class 含 switch → switch 角色
    // (2026-09-28 组件审计:纯 div 开关无角色映射,LLM 不知道可点击 toggle)
    if (/(?:^|[\s_-])(?:switch)(?:[\s_-]|$)/i.test(
      String(element.getAttribute("class") || "")
    )) {
      return "switch";
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
  const iconLabelOf = element => {
    const describedBy = element.getAttribute("aria-describedby");
    if (describedBy) {
      const tip = document.getElementById(describedBy);
      const text = tip ? (tip.innerText || tip.textContent || "").trim() : "";
      if (text) return text.slice(0, 40);
    }
    for (const attr of element.attributes) {
      if (attr.name.startsWith("data-") && /[\u4e00-\u9fff]/.test(attr.value)) {
        return attr.value.slice(0, 40);
      }
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const src = document.getElementById(labelledBy);
      const text = src ? (src.innerText || "").trim() : "";
      if (text) return text.slice(0, 40);
    }
    return "";
  };
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
    iconLabelOf(element) ||
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
    // 弹层豁免(p-pilot 补丁 2026-09-28 真机:el-select popper teleport 到
    // body 但初始 display:none/动画期间 opacity:0,TreeWalker 直接 reject
    // 整棵子树——下拉选项从进不了快照,VL 也只在快照内挑,两路全灭)。
    // 是 popper 类容器就跳过 hidden 检查,只看有没有尺寸。
    const isPopper = /(?:^|[\s_-])(?:el-popper|el-select__popper|el-picker__popper|el-dropdown__popper|vben-popper|ant-select-dropdown)(?:[\s_-]|$)/.test(
      String(element.getAttribute("class") || "")
    ) || element.getAttribute("role") === "listbox";
    const style = globalThis.getComputedStyle(element);
    if (!isPopper && (style.display === "none" || style.visibility === "hidden")) {
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
  const boxes = []; // (ref, role, name, rect) —— 后处理邻近命名用
  while (current && count < maxNodes) {
    const ref = `e${count + 1}`;
    const role = roleOf(current);
    const name = nameOf(current, role);
    const target = selectorOf(current);
    boxes.push({
      ref,
      role,
      name,
      rect: current.getBoundingClientRect()
    });
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
  // combobox 邻近按钮自动命名(p-pilot 补丁 2026-09-28 真机:el-select 的
  // 箭头/触发图标是同排无名 button,LLM 不知道哪个能点开弹层)。规则:
  // 无名 button/role=button 的 box 与 combobox 垂直重叠、水平距离 ≤24px →
  // 命名为 "<combobox 名或占位>的下拉箭头",tree 行同步重写。
  const combos = boxes.filter(b => b.role === "combobox" && b.rect.width > 0);
  if (combos.length) {
    const arrows = boxes.filter(
      b => b.role === "button" && !b.name && b.rect.width > 0 && b.rect.width <= 40
    );
    for (const combo of combos) {
      for (const arrow of arrows) {
        const verticalOverlap =
          arrow.rect.top < combo.rect.bottom && arrow.rect.bottom > combo.rect.top;
        // el-select 箭头两种位置:①combobox 内部右侧(absolute inset,gap 大负数)
        // ②combobox 外部紧右(gap 0-24px)。统一判:箭头中心在 combobox 右侧
        // 25% 区域内(相对 combobox 宽度)
        const arrowCenterX = arrow.rect.left + arrow.rect.width / 2;
        const comboRightZone = combo.rect.left + combo.rect.width * 0.75;
        const inRightZone = arrowCenterX >= comboRightZone && arrowCenterX <= combo.rect.right + 24;
        if (verticalOverlap && inRightZone) {
          const label = (combo.name || "下拉框") + "下拉箭头";
          const idx = parseInt(arrow.ref.slice(1), 10) - 1;
          if (idx >= 0 && idx < lines.length) {
            lines[idx] = lines[idx].replace(
              /^(\s*- button)( \[ref=)/,
              `$1 "${label}"$2`
            );
            if (refs[arrow.ref]) {
              refs[arrow.ref].name = label;
            }
          }
        }
      }
    }
  }

  // 弹层选项直采(p-pilot 补丁 2026-09-28 终极铁证:el-select 选项 teleport
  // 到 body(#app 外),容器折叠时选项 rect=0x0 → TreeWalker skip 整棵子树。
  // 但弹层开着时容器本身有尺寸,选项只是 LI 自身 0x0(虚拟滚动/懒渲染)。
  // 后处理:直接查 body 下所有 .el-select-dropdown__item / [class*=dropdown__item],
  // 有文字的逐个追加进快照,带索引 selector 可执行。
  if (count < maxNodes) {
    const dropdownItems = document.querySelectorAll(
      ".el-select-dropdown__item, [class*='dropdown__item'], .el-dropdown-menu__item"
    );
    for (const item of dropdownItems) {
      if (count >= maxNodes) break;
      const text = (item.innerText || item.textContent || "").trim();
      if (!text || text.length > 80) continue;
      const container = item.closest("[class*='popper'], [class*='dropdown'], [role='listbox']");
      if (container) {
        const cr = container.getBoundingClientRect();
        if (cr.width === 0 && cr.height === 0) continue; // 弹层关着
      }
      count += 1;
      const ref = `e${count}`;
      const sel = selectorOf(item);
      const escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      lines.push(`- option "${escaped}" [ref=${ref}]`);
      refs[ref] = {
        selector: sel.selector,
        role: "option",
        name: text,
        nth: sel.nth,
        tagName: item.tagName.toLowerCase(),
        id: item.id || null,
        nameAttr: item.getAttribute("name")
      };
    }
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
