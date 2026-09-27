/** Shared transport for the extension, Recorder and local Workbench surfaces. */
export function createLanguageClient(options) {
  let current = { mode: "system", locale: null, effectiveLocale: normalize(options.browserLocale()) };
  const listeners = new Set();
  let refreshing;
  let writing = false;
  let generation = 0;

  function accept(value) {
    if (!value || !["en", "zh-CN"].includes(value.effectiveLocale)) {
      throw new Error("Invalid language preference response");
    }
    const changed = JSON.stringify(current) !== JSON.stringify(value);
    current = value;
    void Promise.resolve().then(() => options.writeCache?.(value)).catch(() => {});
    if (changed) listeners.forEach(listener => listener({ ...current }));
    return { ...current };
  }

  async function request(method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await (options.fetch || globalThis.fetch)(options.endpoint, {
        method, signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(payload.message || "Language settings are unavailable");
      return payload.data || payload;
    } finally {
      clearTimeout(timer);
    }
  }

  function browser() {
    return { browserSource: options.browserSource, browserLocale: options.browserLocale() || "en" };
  }

  function refresh() {
    if (writing) return Promise.resolve({ ...current });
    if (refreshing) return refreshing;
    const started = generation;
    refreshing = request("POST", browser()).then(value => started === generation ? accept(value) : { ...current })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    value: () => ({ ...current }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async initialize() {
      try {
        const cached = await options.readCache?.();
        if (cached?.effectiveLocale) accept(cached);
      } catch { /* A missing or damaged cache must not prevent startup. */ }
      try { await refresh(); } catch { /* Offline surfaces retain their last synchronized language. */ }
      return { ...current };
    },
    refresh,
    async set(value) {
      if (!["system", "en", "zh-CN"].includes(value)) throw new Error("Unsupported language preference");
      writing = true;
      generation++;
      try {
        return accept(await request("PUT", {
          ...browser(), mode: value === "system" ? "system" : "override", locale: value === "system" ? null : value
        }));
      } finally { writing = false; }
    }
  };
}

export function normalize(value) {
  return String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
