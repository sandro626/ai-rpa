if (location.pathname === "/aivane/browser/v1/wake") {
  void chrome.runtime.sendMessage({ type: "aivane.bridge.wake" });
}
