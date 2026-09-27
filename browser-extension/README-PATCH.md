# p-pilot patched fork of AIVane Browser Bridge

上游:AIVane Browser Bridge(seed 为 0.6.5,补丁与 0.6.7 载体版本无关——roleOf 两版同构)(Chrome Web Store `gaeifnpdkgmchkdfilibapkdiecaelmg`,
2026-09-27 从已安装副本 vendor,源码未压缩可直接维护)。manifest 已去 `key`/`update_url`
并改名 `(p-pilot patched)` → 独立扩展 ID,与商店版并存互不覆盖。

## 补丁内容

### snapshot.js:可点击自定义控件补名(2026-09-27)

上游 `roleOf` 只认显式 role 与原生表单标签,vben/ElementPlus 类 SPA 的按钮/下拉/表格
操作列全是纯 div/li/span → 快照里成无名 group,p-pilot 的 LLM 看不见「学校切换」这类
顶栏控件(2026-09-27 真机实证,任务 16+ 步滚动找不到)。补丁三路启发式补
`role=button`(名字由 nameOf 的 role 分支自动取 innerText):

1. 显式交互属性:`onclick` / `tabindex=0`
2. 交互 class:`btn`/`button`/`clickable`/`pointer` 词元
3. 计算样式:`cursor: pointer`

守卫:元素内已含真实交互控件(`button/a/input/select/textarea/[role]`)时不提升包装层
(避免容器抢走子控件的角色)。与受管 Chrome 模式 web 适配器 2026-09-19 的同款口径。

## 安装(p-pilot 开发/内部用)

1. `chrome://extensions` → 开发者模式 → **先移除或停用商店版 AIVane Browser Bridge**
   (两个实例同时连桥会抢单条命令通道)
2. 「加载已解压的扩展程序」→ 选本目录(fork 的 `browser-extension/`,本地 clone 路径)
3. 打开扩展 Options 页确认 bridge 已连接;新扩展 ID = 新客户端身份,如侧栏报
   UNPAIRED,按 p-pilot 配对流程重新配对
4. 验证:对目标页发起任务,trace 的 snapshot_elements 应出现原先无名的顶栏按钮名

## 升级策略

商店版更新时:从安装目录 vendor 新版本 → `git diff` 对齐官方变更 → 重放本目录累积的
**两处**补丁(清单以文末「补丁清单」为准,与本节口径必须一致)→ 重装 unpacked →
`bridge.ping` 复核 `pagePressKey` 探测标记仍在:

1. **snapshot.js 可点击自定义控件补名**:`roleOf`/`looksClickable` 块
2. **page.pressKey 无定位组合键**:`debugger-input.js` 的 `parseKeyCombo`/
   `dispatchPageKeyPress`,及 `command-router.js` 三处(import、能力表
   `pagePressKey: true` 标记、`page.pressKey` 路由分发)

迁移挂账:将来迁 GitHub fork 建仓(spec §6,倾向 sandro626/ai-rpa 子目录;公开仓
决策已知情,建仓动作挂账),迁移后以 fork 为上游、本补丁提 PR 收敛。


## 补丁清单(本目录累积)

1. **snapshot.js 可点击自定义控件补名**(2026-09-27,自 0.6.7 载体移植;原
   packages/sidecar/aivane-extension 目录已删,单一载体在 tools/)
2. **page.pressKey 无定位组合键**(hotkey 线,spec 2026-09-27 §3;bridge.ping
   探测 pagePressKey 标记)
