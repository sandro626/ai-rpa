import { t, initializeLanguage, setLanguage, applyLanguage } from "./language.js";
import {
  DEFAULT_BRIDGE_BASE_URL,
  validateLoopbackEndpoint
} from "./protocol.js";

const profileInput = document.querySelector("#profile-id");
const bridgeInput = document.querySelector("#bridge-url");
const form = document.querySelector("#settings");
const bridgeStatus = document.querySelector("#bridge-status");
const saveStatus = document.querySelector("#save-status");

await initializeLanguage(() => { void refreshStatus(); });
await restore();
await refreshStatus();

form.addEventListener("submit", event => {
  event.preventDefault();
  void save();
});

async function restore() {
  const stored = await chrome.storage.local.get([
    "profileId",
    "bridgeBaseUrl"
  ]);
  profileInput.value = stored.profileId || "default";
  bridgeInput.value = stored.bridgeBaseUrl || DEFAULT_BRIDGE_BASE_URL;
}

async function save() {
  saveStatus.textContent = "";
  try {
    const profileId = profileInput.value.trim() || "default";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) {
      throw new Error(
        t("profileInvalid")
      );
    }
    const bridgeBaseUrl = validateLoopbackEndpoint(bridgeInput.value.trim());
    await chrome.storage.local.set({
      profileId,
      bridgeBaseUrl
    });
    saveStatus.textContent = t("saved");
    globalThis.setTimeout(() => void refreshStatus(), 700);
  } catch (error) {
    saveStatus.textContent = error?.message || String(error);
  }
}

async function refreshStatus() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({
      type: "aivane.browser.status"
    });
  } catch (error) {
    status = { ok: false, message: error?.message || String(error) };
  }

  setStatus(
    bridgeStatus,
    status?.connected ? t("connected") : t("waiting"),
    status?.connected
  );
}

function setStatus(element, text, good) {
  element.textContent = text;
  element.classList.toggle("good", good);
  element.classList.toggle("bad", !good);
}

document.querySelector("#language").addEventListener("change", async event => {
  const select = event.target;
  select.disabled = true;
  try {
    await setLanguage(select.value);
    document.querySelector("#language-status").textContent = t("languageSaved");
  } catch (error) {
    document.querySelector("#language-status").textContent = error.message;
    applyLanguage();
  } finally { select.disabled = false; }
});
document.querySelector("#language").disabled = false;
