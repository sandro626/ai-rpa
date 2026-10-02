// 轮询宿主:LoopbackLongPollClient 全量运行于此(配置同源 chrome.storage.
// local),dispatch 中继给 SW 执行。SW 可被 Chrome 随时驱逐——消息会唤醒它;
// 驱逐期间轮询不停,命令零丢失(2026-10-02 真机:死亡窗 27s≈30s 闹钟周期,
// 任务启动命令屡次团灭,根治即轮询出 SW)。
import { LoopbackLongPollClient } from "../src/loopback-client.js";

// offscreen 文档无 chrome.storage(2026-10-02 真机首跑即炸:reading 'local'
// of undefined)——配置由 SW 经消息递入(chrome.runtime 是宿主唯一可靠面)。
// SW 侧 loadConfiguration 已保证 clientId/bridgeSecret 落库,宿主只消费。
async function loadConfiguration() {
  const reply = await chrome.runtime.sendMessage({ aivaneNeedConfig: true });
  if (!reply || reply.ok !== true) {
    throw new Error("config relay failed: " + String(reply && reply.error));
  }
  return reply.config;
}

// dispatch 中继:offscreen 无 chrome.debugger/scripting 执行面,消息唤醒
// SW 用其既有 dispatch 执行;错误按 {ok:false,code,message} 还原为 throw
const dispatch = async (method, parameters, metadata) => {
  const reply = await chrome.runtime.sendMessage({
    aivaneDispatch: { method, parameters, metadata }
  }).catch(error => ({ ok: false, code: "RELAY_FAILED", message: String(error) }));
  if (!reply || reply.ok !== true) {
    const err = new Error((reply && reply.message) || "SW dispatch relay failed");
    err.code = (reply && reply.code) || "RELAY_FAILED";
    throw err;
  }
  return reply.result;
};

let client = null;

async function start() {
  if (client?.running) {
    return;
  }
  const configuration = await loadConfiguration();
  client = new LoopbackLongPollClient({ ...configuration, dispatch });
  client.start().catch(error => {
    console.error("[aivane-offscreen] bridge loop stopped:", error);
    client = null;
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.aivaneHostControl === "restart") {
    void (async () => {
      try {
        if (client) {
          await client.stop();
        }
      } catch {}
      client = null;
      await start();
      sendResponse({ ok: true });
    })();
    return true; // async sendResponse
  }
  return false;
});

void start();
