// offscreen 心跳保活(2026-10-03 终版):offscreen 文档不能 fetch localhost
// (Chrome 平台限制),改做 SW 保活——每 25s 向 SW 发 ping,重置其空闲计时器,
// SW 持续轮询不被驱逐。不需要任何网络权限,只走 chrome.runtime 消息。
const KEEPALIVE_INTERVAL_MS = 25000;
let timer = null;

function start() {
  if (timer) return;
  timer = setInterval(() => {
    chrome.runtime.sendMessage({ aivaneKeepalive: true }).catch(() => {
      // SW 可能正被驱逐后唤醒中,忽略(下次 ping 再触)
    });
  }, KEEPALIVE_INTERVAL_MS);
  console.info("[aivane-offscreen] SW keepalive started");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.aivaneHostControl === "restart") {
    start();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

start();
