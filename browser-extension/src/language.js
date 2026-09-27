import { createLanguageClient } from "./language-client.js";
import { DEFAULT_RECORDER_BASE_URL } from "./recorder-client.js";

let client;
let catalogs;
const listeners = new Set();

export function t(key) {
  return catalogs?.[client?.value().effectiveLocale]?.[key]?.message || catalogs?.en?.[key]?.message || key;
}

export function applyLanguage() {
  document.documentElement.lang = client.value().effectiveLocale;
  document.querySelectorAll("[data-i18n]").forEach(node => { node.textContent = t(node.dataset.i18n); });
  const select = document.querySelector("#language");
  if (select) select.value = client.value().mode === "system" ? "system" : client.value().locale;
}

export async function initializeLanguage(onChange = () => {}) {
  const stored = await chrome.storage.local.get(["uiLanguage", "uiLanguageSource"]);
  const source = stored.uiLanguageSource || `extension:${crypto.randomUUID()}`;
  if (!stored.uiLanguageSource) await chrome.storage.local.set({ uiLanguageSource: source });
  catalogs = Object.fromEntries(await Promise.all([["en", "en"], ["zh-CN", "zh_CN"]].map(async ([tag, dir]) => {
    const response = await fetch(chrome.runtime.getURL(`_locales/${dir}/messages.json`));
    return [tag, await response.json()];
  })));
  client = createLanguageClient({
    endpoint: `${DEFAULT_RECORDER_BASE_URL}/language`, browserSource: source,
    browserLocale: () => chrome.i18n.getUILanguage(),
    readCache: () => stored.uiLanguage,
    writeCache: value => chrome.storage.local.set({ uiLanguage: value })
  });
  const changed = () => { applyLanguage(); onChange(); listeners.forEach(listener => listener()); };
  client.subscribe(changed);
  await client.initialize();
  changed();
  const refresh = () => { void client.refresh().catch(() => {}); };
  setInterval(refresh, 2000);
  window.addEventListener("focus", refresh);
  window.addEventListener("languagechange", refresh);
}

export async function setLanguage(value) {
  const result = await chrome.runtime.sendMessage({ type: "aivane.recorder.command", action: "language-ready" });
  if (!result?.ok) throw new Error(t("languageUnavailable"));
  return client.set(value);
}
