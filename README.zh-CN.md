# Gesture Pilot · 手势助手

**在浏览器里录制鼠标与键盘操作 → 存成步骤脚本 → 按计划自动重放。**

Edge / Chromium 的 Manifest V3 扩展，用来辅助重复性的页面操作。

[English](README.md) · [简体中文](README.zh-CN.md)

---

## 能做什么

- **录一次，反复跑** —— 捕获点击、输入、下拉选择、按键、滚动，以及**拖拽**
- **两套回放引擎** —— 合成事件（轻量、无额外权限提示），或 `chrome.debugger` 投递的真实 CDP 输入（`isTrusted === true`）
- **三种触发方式** —— 手动、定时（`chrome.alarms` / offscreen）、**页面加载触发**（带生效域名规则）
- **页面内实时提示层** —— 鼠标轨迹、点击涟漪、拖拽连线、按键胶囊，录制和回放时都显示
- **健壮的元素定位** —— `data-testid` → 稳定 id → name → aria → placeholder → CSS 路径。**坐标永远不作为定位依据**
- **支持 iframe** —— 跨 frame 录制与回放
- **失败一定看得见** —— 所有错误都会显示在 popup 上，不存在静默无响应

---

## 安装

### 用发布包（推荐）

1. 解压 `edge-gesture-pilot-<版本>.zip`，得到 `edge-gesture-pilot/` 文件夹
2. 打开 `edge://extensions/`（Chrome 用 `chrome://extensions/`）
3. 打开 **开发人员模式**
4. 点 **加载解压缩的扩展**，选中刚才那个 `edge-gesture-pilot` 文件夹

装好后工具栏会出现一个蓝色鼠标指针图标。**录制中图标会变红**，popup 关掉也能一眼看出状态。

> 要操作 `file://` 页面，先在扩展详情页打开 **允许访问文件 URL**。

### 从源码构建

```bash
python build-extension.py
```

会重新生成 `icons/`（纯标准库绘制的 PNG，无第三方依赖）、同步 README、校验 manifest 引用的文件是否都存在，并输出 `dist/edge-gesture-pilot-<版本>.zip`。

然后按上面的步骤加载 `edge-gesture-pilot/` 文件夹。

### 为什么没有 .crx

Windows 版 Edge 会拦截非商店来源的 .crx 安装 —— 微软已公开宣布收紧侧载扩展，Edge Canary 甚至移除了「允许来自其他应用商店的扩展」开关。把 .crx 拖到扩展页大概率直接失败；就算你自己用 `edge://extensions` → **打包扩展程序** 生成一个，装的时候一样会被拦。

真想要一键安装，只有上架 Edge 加载项商店这一条路（免费开发者账号 + 审核 + 隐私政策声明），审核要几天。

> **如果你自己打包了 .crx**：生成的 `.pem` 是你的**私钥**。绝不能提交到仓库，也绝不能外传 —— 拿到它的人可以用你的扩展 ID 签名更新。`.gitignore` 里已经排除它。

### 权限警告说明

加载时会出现两条警告，属预期，不是配置错误：

| 警告 | 来源 |
|---|---|
| 读取和更改您在所有网站上的数据 | `host_permissions: <all_urls>`（录制/回放必须注入任意页面） |
| 调试此浏览器 | `debugger` 权限（CDP 真实输入引擎需要） |

如果你只用合成事件引擎、不需要 CDP，可以从 `manifest.json` 的 `permissions` 里删掉 `"debugger"`，第二条警告就没了。同时设置面板里的 CDP 选项会失效。

---

## 用法

### 录制

1. 打开目标页面，停在流程的起始位置
2. 点扩展图标 → **开始录制**（图标变红，popup 可以关掉，录制在页面上继续）
3. 在页面上正常操作一遍：点击、输入、选择下拉、回车、滚动、拖拽
4. 点扩展图标 → **停止并保存**

录到的内容会出现在脚本列表里。

### 定时

展开脚本卡片，勾选 **定时自动执行**：

| 周期 | 承载机制 | 说明 |
|---|---|---|
| **≥ 60 秒** | `chrome.alarms` | 官方持久定时，Service Worker 被回收也会唤醒 |
| **< 60 秒** | `offscreen` 文档的 `setInterval` | SW 存活不了那么久，必须由隐藏文档驱动 |

- **每隔** 模式：填数值 + 单位（秒 / 分钟）
- **每天** 模式：指定一个时间点。用一次性 alarm，跑完自动排下一次，能自然跨过夏令时
- **生效域名**：填了之后，定时跑到范围外的页面会**跳过并通知你**，不会在错误的站点上乱点

### 脚本管理

| 操作 | 怎么做 |
|---|---|
| **改名** | 直接点卡片标题，或展开后在「脚本名称」里改 |
| **停用 / 启用** | 卡片左侧的复选框。停用后定时与页面触发都不再生效，**手动仍可运行** |
| **调步骤延时** | 每步右下角的「延时 xxx ms」，改完立即保存 |
| **调整步骤顺序** | 每步的 `↑` `↓`；首尾的按钮会自动禁用 |
| **复制 / 删除步骤** | 每步的 `＋` / `✕` |
| **补一步等待** | 步骤列表底部「＋ 插入等待」，用于给动态页面留时间 |
| **导出 / 导入** | 单条在卡片里「导出此脚本」；全部在 **设置 → 备份与恢复** |

### 快捷键与右键菜单

不想每次去点扩展图标的话：

| 操作 | 默认键 |
|---|---|
| 开始 / 停止录制 | `Ctrl+Shift+E` |
| 运行当前页面匹配的脚本 | `Ctrl+Shift+K` |

在页面任意位置右键也有：**录制 / 停止本页**，以及 **运行脚本 ▸**（列出所有启用的脚本，超过 15 个会提示去面板里选）。

改键位：`edge://extensions/shortcuts`。

「运行当前页面匹配的脚本」按这个顺序找一个：页面触发规则命中 → 定时生效域名命中 → `targetUrl` 同源。都找不到就发通知说明原因，**不会随便挑一个跑**。

### 备份与恢复

**设置 → 备份与恢复**：

- **导出全部脚本** —— 下载一个 JSON，含全部脚本的完整配置与步骤
- **从剪贴板粘贴** —— 把 JSON 贴进输入框（读不到剪贴板时可手动粘贴）
- **导入** —— 按脚本逐条校验：**id 已存在的会跳过，不会覆盖**；结构不完整的也跳过

导入是「补充」语义，所以可以反复导入同一份备份而不会产生重复，也不会误删现有配置。

### 回放引擎

| | 合成事件（默认） | CDP 真实输入 |
|---|---|---|
| 原理 | content script 内 `dispatchEvent` | `chrome.debugger` + `Input.dispatchMouseEvent` |
| `isTrusted` | `false` | `true` |
| 额外权限提示 | 无 | 有（`debugger`） |
| 页面横幅 | 无 | 顶部「正在调试此浏览器」 |
| 与 DevTools | 可共存 | **互斥** |
| 跨域 iframe | 支持 | **不支持**（坐标无法换算） |
| 适合 | 内部后台、老式页面 | 复杂 SPA、要「看起来完全像真人」 |

可以在 **设置** 里设全局默认，也可以在单个脚本里覆盖（脚本设置优先）。

---

## 页面内实时提示

录制开始后，页面上会浮出一层实时提示（**透明背景，不挡操作**，可在设置里关掉）。回放时同样会显示。

| 元素 | 位置 | 说明 |
|---|---|---|
| **状态角标** | 右上角 | `● 录制中 · N 步`，红点脉动；只在顶层 frame 显示 |
| **鼠标轨迹** | 跟随指针 | 蓝色渐隐拖尾 + 指针光环 |
| **点击涟漪** | 点击落点 | 扩散圆环，**左键蓝 / 中键绿 / 右键橙**，并浮出目标元素标签 |
| **拖拽连线** | 按下到抬起 | 橙色流动虚线 + `拖拽 · 已录制` 标签 |
| **按键提示** | 底部居中 | 透明胶囊：`Ctrl`+`Shift`+`S` 这类组合键常亮 1 秒后淡出；`Enter`/`Tab`/`←` 等功能键同样显示；打字时普通字符短暂一现 |
| **输入回显** | 底部居中 | `输入 hello 世界` 这样的胶囊，回放 `input` / `select` 步骤时显示写入的完整内容 |

### 键盘回显：两条路径的实现不一样

- **合成事件引擎**：`pressKey()` 直接调 `GX_HUD.key()`；`input` / `select` 步骤调 `GX_HUD.input()`
- **CDP 引擎**：按键是 service worker 用 `Input.dispatchKeyEvent` 直接投递的，**页面根本收不到事件**，只能由后台发 `GX_HUD_KEY` / `GX_HUD_INPUT` 消息把回显喂进提示层
- **修饰键的来源**：录制时 `Ctrl` 有自己的 keydown/keyup；回放时只有一条 `key` 步骤，`Ctrl` 必须从 `step.key` 的 `ctrl`/`alt`/`shift`/`meta` 标志里补出来。合成出来的修饰键**没有对应的 keyup**，所以必须跟着主键一起淡出，否则会在页面底部越堆越多

### 实现细节

- 整层挂在 **Shadow DOM** 里，页面 CSS 影响不到它；并且 `pointer-events: none`，不会抢走页面的鼠标事件（否则会把点击录成 HUD 自己的）
- 鼠标轨迹与涟漪走 **canvas**（避免大量 DOM 节点抖动），文字类提示走 DOM
- 每个 frame 各画各的，用自己 frame 的坐标系 —— 所以 iframe 里的操作也能看到反馈。但**状态角标只在顶层 frame 显示**，否则多 iframe 页面会冒出一排
- 小于 240×160 的 frame 直接放弃渲染（站点常挂 1×1 统计 iframe）
- HUD 的所有接口都吞异常：**提示层坏掉绝不会连累录制本身**
- CDP 引擎回放时，只有顶层 frame 会画涟漪（CDP 用的是顶层视口坐标，画到子 frame 里会错位）

打开 **设置 → 录制时在页面上显示实时提示** 可以关掉。

---

## 触发条件

除了定时器，脚本还可以在**打开某个页面时自动跑起来**。展开脚本卡片即可配置。

| 配置 | 说明 |
|---|---|
| **打开页面时自动触发** | 总开关 |
| **生效域名** | 留空 = 所有域名。逗号 / 分号 / 空格分隔。定时那一栏也各有一份，两条路径互不影响 |
| **加载后等 N 秒** | 页面加载后先等一会儿再动，给 SPA 渲染留时间 |
| **等元素** | 填 CSS 选择器。非空时会先等这个元素出现，**等不到就不触发**（比固定延迟可靠得多） |
| **等标签页切到前台** | 勾上后，后台标签页不会触发，等你切过去再动 |
| **冷却 N 秒** | 两次触发之间的最小间隔，防止脚本自己导航又把自己触发起来 |
| **同一次页面加载只触发一次** | 默认开启。按「页面加载」计数，刷新页面算新的一次 |

### 生效域名的写法

| 写法 | 匹配 |
|---|---|
| `example.com` | `example.com` 及其所有子域（`a.example.com`、`a.b.example.com`） |
| `*.example.com` | 只匹配子域，不含 `example.com` 本身 |
| `10.0.0.5:8080` | 带端口的 host |
| `https://a.com/admin` | 带协议时按整段 URL 前缀匹配（可含路径） |

`notexample.com`、`evil-example.com`、`example.com.evil.com` **都不会**命中 `example.com` —— 后缀伪装在匹配规则里被专门挡掉了。

展开卡片时，界面会实时显示 **「当前页面匹配 / 不匹配」**，省得你猜为什么没触发。

### 触发是怎么保证不失控的

脚本跑起来可能会导航到别的页面，而导航又会再次满足触发条件 —— 处理不当就是死循环。三道闸门：

1. **同一次页面加载只触发一次**（内容脚本每次加载生成一个 `loadId`，后台记住已触发的那个）
2. **冷却**（两次触发之间的最小间隔）
3. **已有脚本在运行时，新的触发直接跳过**，不让两个自动化互相踩

这三件事都放在 service worker 侧：内容脚本每次页面加载都是全新实例，记不住「刚刚已经跑过」，而它们恰恰需要跨页面加载的记忆。

跳过原因会打到页面控制台，前缀是 `[Gesture Pilot]`。

---

## 拖拽

拖拽会被录成独立的 `drag` 步骤，回放时按原路径重演。

- **路径以「相对拖拽起点的偏移」保存**，所以布局有些许位移也能落在合理位置
- 采样间隔 25ms，落库前抽稀到最多 48 个点（原始采样能有几百个，存下来又大又慢，观感却没区别）
- 回放时 `mousemove` 会带上 `buttons: 1` —— **不带这个，页面的拖拽逻辑会当成普通移动**
- 事件投递给指针底下的元素（`elementFromPoint`），兼顾把监听挂在 `document` 上和挂在自己身上两类实现
- 录制与回放的**鼠标轨迹视觉一致**：都是渐隐拖尾；拖拽期间额外画一条橙色流动虚线

> **原生 HTML5 拖放不支持。** `draggable="true"` + `dragstart/dragover/drop` 那套是浏览器的内部机制，合成事件无法驱动（要 CDP 的 `Input.dispatchDragEvent`，当前未实现）。滑块、画布拖拽、自定义拖拽这类自己监听 mousedown/mousemove/mouseup 的都能正常录放。

---

## 排查：点了没反应 / 录制不上

### 怎么确认正在跑的是哪个版本

popup 标题栏上的 **`v0.4.0`** 就是当前版本。鼠标悬停能看到「界面 vX｜后台 vY」。

如果两个版本号不一致，popup 会在标题下方显示一条**黄色警告**，直接告诉你该做什么。这条警告是自动检测的：

- popup 发起 `SCRIPT_LIST` 时，后台会把自己的版本号一起返回
- 对不上（或后台压根没返回版本号 = 后台是旧代码）就报警
- 报错信息里出现 `is not defined` / `is not a function` 这类字样时，也会判定为后台旧代码并一并提示

### 改了代码后一定要「重新加载」

在 `edge://extensions` 找到本扩展，点卡片上的 **↻ 重新加载**。

> **注意**：MV3 下改完 `background.js`，单点一次重新加载**有时不会重启 service worker**，看起来像没生效（popup 是新版、后台还是旧版）。
>
> 如果 reload 后版本号还是不一致，就**移除**这个扩展，再重新「加载解压缩的扩展」。这是最可靠的。

### 装了扩展之后，已经开着的标签页要刷新一次

这是 MV3 最容易踩的坑：**静态 content script 只对「扩展加载之后新开或刷新过的页面」生效。**

`RECORD_START` 现在会先按需注入（`ensureRecorderInjected`）再广播，所以理论上老标签页也能录。但如果还是没反应，**先按 F5 刷新一下目标页面**，这是最快的排除手段。

### 「点了没反应」现在一定会告诉你原因

早期版本的 `popup.js` 事件处理只有 `try/finally` 没有 `catch`，后台抛错会变成静默无响应。现在：

- 所有失败都会在 popup 顶部显示红色横幅
- 后台完全联系不上时会提示你去 `edge://extensions` 看「错误」和 service worker 控制台
- 兜底的 `unhandledrejection` / `error` 监听保证没有异常会被吞掉

### 看 service worker 的真实日志

`edge://extensions` → 本扩展卡片 → 点 **service worker** 链接，会打开 DevTools。
所有 `chrome.runtime.lastError`、未捕获异常都在这里。

### 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 黄色警告「后台跑的是旧代码」 | 改了文件但 service worker 没重启 | 点 ↻ 重新加载；无效就**移除后重新加载** |
| 报错里出现 `xxx is not defined` | 同上，后台还在跑旧代码 | 同上 |
| 提示「无法向该页面注入脚本」 | 当前是 `edge://`、扩展页或商店页 | 换普通网页 |
| 提示「已注入但没有响应」 | 页面是特殊页，或注入被 CSP 拦 | 刷新页面重试 |
| 提示「当前页面不支持录制」 | `file://` 未授权 | 扩展详情页打开「允许访问文件 URL」 |
| 提示「**有 N 个 frame 有响应**，但没有捕获到操作」 | 录制通道是通的，确实没操作到东西 | 确认操作的是当前标签页；输入框里纯打字要**离开输入框**才会聚合成步骤 |
| 提示「**没有任何 frame 响应**」 | 页面已关闭 / 跳走，或注入失效 | 刷新目标页面重试 |
| 回放时元素找不到 | 选择器太脆（页面结构变了） | 展开脚本详情，改用更靠前的定位方式；或给目标元素加 `data-testid` |
| 回放点了但页面无反应 | 站点校验 `isTrusted` | 切到 **CDP 真实输入** 引擎（记得先关 DevTools） |
| CDP 模式报「开发者工具占用」 | DevTools 打开着 | 关掉 DevTools 再跑 |

### 为什么录制状态必须放在 storage.session 里

MV3 的 service worker 空闲约 **30 秒**就被回收。而录制期间的真实情况是：你点完「开始录制」popup 就关了（不再轮询），然后去页面上操作 —— SW 必然被回收过。

如果录制状态放在 SW 的模块变量里，回收后会被清零，各 frame 上报的步骤就被**静默丢弃**，表现就是「录制成功但一步都没有」。

所以现在的实现是：

- 录制状态存在 `chrome.storage.session`，SW 重启后照样能读到
- 录制器**边录边增量上报**（250ms 防抖）+ `pagehide` 时补报一次，页面中途导航也不会丢
- 停止时再全量上报一次，两条路径靠步骤自带的 `sid` 去重
- 页面在录制期间重新加载会**同源自动续录**（靠 `chrome.storage.session.setAccessLevel` 让内容脚本读得到录制状态）

---

## 测试

沙箱里开不了浏览器，所以配了三套 Node 冒烟测试，用伪造的 `chrome.*` API 和 DOM 垫片把代码**真正执行**一遍。运行：

```bash
node tools/mock-harness.mjs      # Service Worker：录制/调度/回放/CDP/拖拽/offscreen/触发/菜单/快捷键/导入（91 项）
node tools/content-harness.mjs   # 内容脚本：加载、HUD 绘制与回显、拖拽录放、域名规则、触发行为（138 项）
node tools/popup-harness.mjs     # popup：加载、事件绑定、错误可见、版本自检、改名、步骤编辑、备份恢复（64 项）
```

这些测试抓的是 `node --check` 抓不到的问题：未定义引用、字段拼错、状态机走空、错误被静默吞掉。

已经靠它抓到并修掉的真实缺陷：

- `broadcast()` 被调用但从未定义（点了没反应）
- `SCRIPT_UPDATE` 漏调 `syncAlarms()`，改成秒级周期不生效
- 录制状态放在 SW 模块变量里，SW 被回收后步骤全丢（录制成功但一步都没有）
- `flushInput` 拿「初始值」比对，导致只敲一个字符的输入整条被丢弃
- `runStep` 对没有 locator 的 `key` 步骤仍去等元素，白等 8 秒后失败（页面级快捷键走不通）
- HUD 里合成出来的修饰键没有 keyup，会在页面底部无限累积
- 合成事件用了顶层视口坐标而不是本 frame 坐标，iframe 里的点击 `clientX` 会偏
- 指针停住后 HUD 仍以 60fps 空转重绘（长时间录制白耗电）

本轮（v0.5.0）新增的回归覆盖：定时生效域名守卫、脚本停用后不建 alarm 也不响应触发、老脚本读取时自动补全结构、导入的去重与坏数据兜底、右键菜单与快捷键、改名提交、步骤上移/下移/复制/删除/延时编辑。

域名匹配有一份可复用逻辑（`lib/domains.js`）和一份内容脚本内的实现（`content/trigger.js`，内容脚本不能用 `import`）。
`tools/content-harness.mjs` 里有 23 组用例把两者**对拍**，保证不会走出分歧。

---

## 目录结构

```
manifest.json              MV3 清单
background.js              Service Worker：消息路由 / 调度 / 回放编排
lib/storage.js             脚本 CRUD、设置、运行状态、触发默认值
lib/cdp.js                 CDP 引擎（chrome.debugger 封装）
lib/domains.js             生效域名匹配（popup 共用；trigger.js 里有一份等价实现）
content/selector.js        元素定位 + 坐标换算 + 受控组件写入（注入所有 frame）
content/hud.js             页面内实时提示层（鼠标轨迹 / 点击涟漪 / 按键胶囊）
content/recorder.js        录制器（注入所有 frame）
content/replayer.js        合成事件回放（按需注入）
content/trigger.js         页面加载触发引擎（只注入顶层 frame，document_idle）
offscreen/                 秒级定时器宿主
popup/                     界面
icons/                     build-extension.py 生成（icon* = 正常，rec* = 录制中）
tools/                     Node 冒烟测试
build-extension.py         图标生成、校验、打包
```

---

## 脚本数据结构

```jsonc
{
  "id": "s_lx8f3a",
  "name": "订单后台 · 10-09 14:52",
  "targetUrl": "https://example.com/orders",
  "enabled": true,                   // 总开关：false = 定时与页面触发都停，手动仍可跑
  "engine": null,                    // null = 跟随全局设置
  "schedule": {
    "enabled": true,
    "mode": "interval",              // interval | daily
    "everySec": 1800,                // < 60 走 offscreen，>= 60 走 alarms
    "time": "09:30",                 // daily 模式使用
    "domains": ["example.com"]       // 生效域名：留空 = 不限
  },
  "trigger": {
    "enabled": true,
    "domains": ["example.com", "*.internal.test"],
    "delaySec": 3,
    "readySelector": "#app-ready",
    "readyTimeoutSec": 20,
    "requireVisible": false,
    "once": true,
    "cooldownSec": 120
  },
  "steps": [
    { "type": "click",  "locator": {}, "rel": { "x": 0.51, "y": 0.48 }, "delay": 0 },
    { "type": "input",  "locator": {}, "value": "ORD-2026", "delay": 1240 },
    { "type": "select", "locator": {}, "value": "SHIPPED",  "delay": 620 },
    { "type": "key",    "locator": {}, "key": { "key": "Enter", "code": "Enter", "vk": 13 }, "delay": 300 },
    { "type": "wheel",  "deltaY": 900, "delay": 800 },
    { "type": "drag",   "locator": {}, "rel": { "x": 0.1, "y": 0.5 },
      "path": [{ "x": 0, "y": 0 }, { "x": 60, "y": 10 }, { "x": 150, "y": 0 }], "delay": 200 }
  ]
}
```

### 定位器分级

越靠前越稳：

| kind | 例子 | 说明 |
|---|---|---|
| `attr` | `[data-testid="submit-order"]` | 显式测试属性，最稳 |
| `css` | `#order-filter` | 稳定 id（会过滤掉 `btn-1697123456789` 这类易变 id） |
| `attr` | `[name="orderNo"]` | 表单 name |
| `aria` | `「提交订单」` | 无障碍名 / 可见文本模糊匹配 |
| `attr` | `[placeholder="请输入订单号"]` | placeholder |
| `css` | `div:nth-of-type(2) > button:nth-of-type(1)` | 最后的兜底，最脆 |

**坐标永远不作为定位依据**，只在点击时记录元素内的相对落点（0~1），换个分辨率也不会偏。

---

## 几个关键实现细节

### Service Worker 会被回收

MV3 的 SW 空闲约 30 秒就被终止，所以：

- ❌ 不能用 SW 里的 `setTimeout` / `setInterval` 做定时
- ✅ 定时一律走 `chrome.alarms` 或 offscreen 文档
- ✅ 运行状态写进 `chrome.storage.session`，popup 靠轮询读取进度
- ✅ 每分钟一个看门狗 alarm，检查 offscreen 文档是否被意外关掉

### 受控组件写入

React / Vue 会劫持原型上的 `value` setter，直接 `input.value = x` 不会触发 `onChange`。`selector.js#setNativeValue` 绕过原型调用原生 setter，再派发 `input` + `change`。

### 点击为什么要补一次 `el.click()`

`mousedown` / `mouseup` 合成事件只能覆盖监听器，**链接跳转、表单提交、label 联动这些默认行为不会触发**。所以先派发 `mousedown`/`mouseup`，再调 `el.click()` —— 后者只派发 `click`，不会重复触发前两个，因此不会双触发。

### 鼠标轨迹自然化

默认开启。贝塞尔曲线 + 非匀速（easeInOutQuad）+ 微小抖动，避免「直线等速瞬移」这种明显的程序化特征。可在设置里关掉。

### iframe

- 录制器与选择器注入 **所有 frame**（`all_frames: true`）
- 各 frame 的步骤带 `frameUrl`，停止时通过 runtime 消息上报，SW 按时间戳合并
- 回放时用 `webNavigation.getAllFrames` 建立 `url → frameId` 映射，逐步投递到正确的 frame
- 顶层 frame 的步骤不带 `frameUrl`，避免 SPA 路由变化后匹配失败

---

## 已知边界

| 限制 | 说明 |
|---|---|
| **原生 HTML5 拖放** | `draggable="true"` + dragstart/drop 无法用合成事件驱动，需要 CDP 的 `Input.dispatchDragEvent` |
| **跨 frame 拖拽** | 路径保存在起始 frame 的坐标系里，拖到另一个 frame 上不会跟着换算 |
| **`<select>` 的下拉选择** | 依赖 `change` 事件录制，原生下拉弹层内的选择动作本身不被记录 |
| **CDP + 跨域 iframe** | 坐标无法换算（`frameElement` 跨域不可读），会明确报错而不是静默点错位置 |
| **CDP + `<select>`** | 需要键盘方向键模拟，成本高，自动退回合成事件 |
| **file input** | 设置文件需要 CDP 的 `DOM.setFileInputFiles`，当前只留了挂载点 |
| **SPA 路由跳转** | 只记录起始 `targetUrl`，站内路由变化按普通页面状态处理 |
| **`isTrusted=false` 校验** | 显式校验的站点会拒绝合成事件 —— 这是浏览器硬限制，换 CDP 引擎 |
| **执行失败** | 重试后仍失败 → 暂停 + 桌面通知 + 截图留证（在设置里控制） |

### 秒级定时的 `reasons` 说明

`chrome.offscreen.createDocument` 的 `reasons` 枚举里**没有「定时器」这一项**，代码里用的是 `'WORKERS'`（影响最小的一条）。这是 Chrome 的 API 设计缺口，不是写法问题。

---

## 调参速查

| 场景 | 建议 |
|---|---|
| 页面慢、元素出现晚 | 调大 **单步超时**（默认 8000ms） |
| 明明元素在却报找不到 | 检查是否需要先在页面上手动登录；或加大超时 + 重试次数 |
| 跑得太慢 | 调大 **播放倍速**（>1 更快），或调小 **间隔封顶** |
| 跑得太快、页面没反应过来 | 调大 **步骤最小间隔**（默认 180ms） |
| 需要更像真人 | 保持 **鼠标轨迹自然化** 开启，调大 **随机抖动上限** |
| 显式校验 `isTrusted` 的站点 | 切到 **CDP 真实输入** 引擎（记得关掉 DevTools） |

---

## 许可证

[MIT](LICENSE)
