# PRD：DSH–Hermes 双向桥接工具（`dsh-hermes-bridge`）

## 1. 背景与目标

### 1.1 背景

在同一台 Linux 工作站上同时运行两个 Agent 系统：

* [**DeepSeek Harness (DSH)**](https://github.com/deepseek-ai/deepseek-harness)：负责高强度、24 小时运行的编码开发与实验执行，基于 Cordis 的“万物皆插件”架构（[DSH 架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）。

* [**Hermes Agent**](https://github.com/NousResearch/hermes-agent)：已接入用户的 Telegram（[Hermes Telegram 文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram)），用于用户在手机端随时沟通与下达指令。

当前痛点在于 DSH 并非完全无人值守：当 DSH 的敏感 Tool Call 被 Auto Review 拦截进入人工审批（[Auto Review 讨论 #12109](https://github.com/deepseek-ai/deepseek-harness/discussions/12109)）、Agent 调用 `ask_user_question` 向用户提问、或遇到 API 欠费/限流中断时，如果用户不在工作站前，任务会长期挂起甚至白等一夜。

### 1.2 核心目标

开发一套同机双向桥接工具 `dsh-hermes-bridge`，实现以下闭环：

1. **主动状态上报**：当 DSH 中任意任务进入**暂停**（等待 Tool Call 授权、向用户提问）、**异常中断**（API 欠费、限流、流错误）或**停止**（Turn 完成/中止）状态时，自动触发 Hermes 通过 Telegram 主动向用户汇报“哪个任务、处于什么状态、具体详情是什么”。

2. **纯文字远程控制**：用户在 Telegram 中仅通过**最基本的自然语言纯文字对话**回复 Hermes，即可完成同意/拒绝 Tool Call、回答 DSH 提问、补充新指令或中止任务。

3. **不破坏本地体验**：电脑端打开 DSH Web UI 时，本地审批/提问与手机端 Hermes 审批/提问可同时工作，先响应者生效。

### 1.3 非目标（明确不做）

* **不在 Hermes / Telegram 侧引入任何特殊交互格式**：不开发 Telegram 内联按钮、选项卡片、投票问答表单，也不要求用户输入 `/approve`、`/answer` 等斜杠命令或手抄任务 ID。

* **不暴露公网服务**：DSH 与 Hermes 位于同一工作站，所有桥接通信严格限制在 `127.0.0.1` 回环地址。

* **不修改 DSH 或 Hermes 核心源码**：仅通过 DSH 官方 Cordis 插件机制（[DSH 插件打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)）和 Hermes 原生 Webhook / MCP / Skill 机制集成。

## 2. 总体架构与仓库结构

### 2.1 通信闭环

1. **上行（DSH → Hermes → Telegram）**：DSH Host 插件监听运行期瀑布流与会话事件，将事件以统一 JSON 格式 `POST` 到 Hermes 本地 [Webhook 适配器](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)（默认 `http://127.0.0.1:8644/webhooks/dsh-events`）。Hermes 将消息以自然语言纯文字推送到 Telegram，并开启 `mirror_to_session: true` 写入会话历史。

2. **下行（Telegram → Hermes → DSH）**：用户在 Telegram 直接回复纯文字。Hermes 结合对话历史与内置 `SKILL.md` 规则理解意图，通过原生 [MCP 协议](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) 调用 DSH 插件暴露的本地 StreamableHTTP MCP Server（默认 `http://127.0.0.1:8790/mcp`），驱动 DSH 解除挂起或继续执行。

### 2.2 单仓库目录结构

采用单仓库布局——根目录直接作为可安装的 DSH Cordis Bundle 插件，`hermes/` 目录存放 Hermes 侧的 Skill 与配置模板，确保双端协议同步演进：

```
dsh-hermes-bridge/
├── package.json                # DSH 插件根清单（声明 dsh.bundle.patch 与 peerDependencies）
├── cordis.patch.yml            # DSH 插件默认挂载配置
├── tsconfig.json
├── src/
│   ├── index.ts                # Cordis 插件入口：导出 name、inject、Config 与 apply(ctx, config)
│   ├── pending-store.ts        # 挂起审批与待答问题的内存状态表及超时管理
│   ├── event-listeners.ts      # DSH 四类事件监听（waterfall + session/event）与防抖
│   ├── webhook-client.ts       # 向 Hermes Webhook 推送（含幂等 ID、密钥头、重试）
│   └── mcp-server.ts           # 本地 StreamableHTTP MCP Server（5 个反控工具）
├── tests/
│   ├── pending-store.test.ts
│   ├── event-listeners.test.ts
│   └── mcp-server.test.ts
├── hermes/
│   ├── skills/
│   │   └── dsh-bridge/
│   │       └── SKILL.md        # Hermes 纯文字汇报与意图翻译规则
│   └── config.example.yaml     # Hermes Webhook 路由 + MCP Server 配置片段
└── scripts/
    └── setup-hermes.sh         # 安装辅助脚本：软链 SKILL.md、生成共享密钥、探测连通性

```

## 3. DSH 侧详细设计

### 3.1 监听的四类状态与触发规则

| 状态枚举（`state`） | 业务场景 | DSH 接入点 | 处理与防抖要求 | 
| ----- | ----- | ----- | ----- | 
| `paused_approval` | Tool Call 等待人工授权（含 Auto Review 拦截或沙箱提权） | `approval/request` 瀑布流 + `approval/asked` 日志（[Discussion #9530](https://github.com/deepseek-ai/deepseek-harness/discussions/9530)） | 入表生成短 `pendingId`，异步 POST Webhook，并 `Promise.race([next(), waitForHermes(id)])`；超时按 `rejected` 收尾，**绝不超时放行** | 
| `paused_question` | Agent 调用 `ask_user_question` 向用户提问 | `user-questions/request` 瀑布流（[Discussion #11178](https://github.com/deepseek-ai/deepseek-harness/discussions/11178)） | 入表生成 `pendingId`，异步 POST Webhook，并 `Promise.race([next(), waitForHermesAnswer(id)])`；默认 30 分钟无响应则超时报错收尾，防无限挂起 | 
| `interrupted_error` | API 欠费（402）、限流（429）、模型流错误或连接中断 | `session/event` 中的 `assistant/attempt` 失败/重试/流错误记录（[DSH 架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)） | 同会话同错误类型 60 秒内合并防抖，避免重试风暴刷屏 Telegram | 
| `stopped` | Turn 正常完成或被中止 | `session/event` 中的 `turn/end`（或 `agent/turn-stopping`） | 附带结束原因及最后一条 `assistant/message` 摘要（截断至 ≤ 500 字符）；可配置忽略极短对话（如 `< 5s` 的普通闲聊 Turn） | 

### 3.2 上行 Webhook 载荷规范（DSH → Hermes）

* **目标地址**：可配置，默认 `http://127.0.0.1:8644/webhooks/dsh-events`

* **请求头**：

  * `Content-Type: application/json`

  * `X-Request-ID: <eventId>`（供 Hermes Webhook 幂等去重，见 [Hermes Webhooks 文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)）

  * 鉴权头（如 `X-Webhook-Secret: <secret>` 或匹配 Hermes 路由配置的签名头）

* **JSON 载荷**：

```
{
  "eventId": "evt_20261123_001032_a3f2",
  "timestamp": "2026-11-23T00:10:32-08:00",
  "sessionId": "sess_xxxxxxxx",
  "taskTitle": "SyncFuzz 回归实验",
  "cwd": "/home/user/workspace/syncfuzz",
  "state": "paused_approval",
  "stateLabel": "等待 Tool Call 授权",
  "pendingId": "apr_a3f2",
  "summary": "Auto Review 拦截了 bash 调用：rm -rf build/cache && pytest -n auto（原因：涉及删除目录）",
  "details": {
    "toolName": "bash",
    "argumentsPreview": "rm -rf build/cache && pytest -n auto",
    "reason": "Auto Review: destructive file removal",
    "expiresAt": "2026-11-23T00:15:32-08:00"
  }
}

```

### 3.3 本地 MCP Server 接口规范（Hermes → DSH）

* **传输协议**：StreamableHTTP MCP，监听 `127.0.0.1:<port>`（默认 `8790`，路径 `/mcp`）。

* **鉴权**：校验 `Authorization: Bearer <authToken>`，未配置 token 时仅允许 loopback 并打印启动警告。

* **暴露工具（共 5 个）**：

| 工具名 | 入参 | 功能与返回值 | 
| ----- | ----- | ----- | 
| `dsh_list_status` | `{ includeRecentStopped?: boolean }` | 返回当前所有挂起审批列表（含 `pendingId`、`taskTitle`、`toolName`、`argumentsPreview`）、挂起提问列表（含 `pendingId`、`questionText`、`options`）及活跃会话列表 | 
| `dsh_decide_approval` | `{ pendingId: string, decision: "allowed-once" | "allowed-session" | "rejected", reason?: string }` | 调用挂起审批对应的 `resolve`；若 `pendingId` 不存在或已失效，返回 `{ ok: false, code: "EXPIRED_OR_RESTARTED" }` | 
| `dsh_answer_question` | `{ pendingId: string, answerText: string, selectedOptions?: string[] }` | 直接 resolve `user-questions/request` 挂起的 Promise；支持将用户自然语言匹配到选项或作为自由文本答案回填 | 
| `dsh_send_instruction` | `{ sessionId: string, message: string }` | 检查该会话当前**无挂起提问**后，通过 `ctx.agents` / `agent.inject()` 注入新指令（[DSH 架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）；若存在挂起提问则拒绝注入并提示先调用 `dsh_answer_question` | 
| `dsh_cancel_session` | `{ sessionId: string, reason?: string }` | 调用 `agent.cancel({ kind: 'user' })` 中止指定会话的当前 Turn | 

### 3.4 插件配置项（`cordis.patch.yml`）

* `mcpHost`（默认 `"127.0.0.1"`）与 `mcpPort`（默认 `8790`）

* `mcpAuthToken`（必填或由启动脚本生成随机串）

* `hermesWebhookUrl`（默认 `"http://127.0.0.1:8644/webhooks/dsh-events"`）

* `hermesWebhookSecret`（与 Hermes 路由一致）

* `approvalTimeoutMs`（默认 `300000`，即 5 分钟；超时自动拒绝）

* `questionTimeoutMs`（默认 `1800000`，即 30 分钟；超时报错收尾）

* `notifyOnTurnEndMinDurationMs`（默认 `10000`，短于该耗时的普通 Turn 可静默不推）

* `errorDebounceMs`（默认 `60000`，同类异常防抖窗口）

## 4. Hermes 侧详细设计（零插件代码，纯文字交互）

### 4.1 Webhook 路由配置（`hermes/config.example.yaml`）

复用 Hermes 原生 [Webhook 适配器](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)：

* 绑定 `host: "127.0.0.1"`、`port: 8644`。

* 路由 `dsh-events` 指向 `deliver: "telegram"`，并**必须开启 `mirror_to_session: true`**，确保推送给用户的通知文本自动落入 Telegram 会话历史，用户直接回复时 Hermes 有完整上下文。

* 默认提供两套注释可选模式：

  * **省 Token 直推模式（默认推荐）**：`deliver_only: true`，使用口语化纯文字模板渲染（例如：`DSH 那边「{taskTitle}」现在处于「{stateLabel}」状态：{summary}`）。

  * **智能润色模式（可选）**：关闭 `deliver_only`，让 Hermes 收到事件后自行用一句自然中文汇报，并顺带给出简短风险提示。

### 4.2 MCP 客户端配置

在 Hermes 的 MCP 配置中注册 `dsh-bridge`（[Hermes MCP 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)）：

* `url: "http://127.0.0.1:8790/mcp"`

* `headers: { Authorization: "Bearer <mcpAuthToken>" }`

### 4.3 纯文字交互 Skill（`hermes/skills/dsh-bridge/SKILL.md`）

通过 Skill 严格约束 Hermes 的对话风格与工具调用逻辑：

1. **纯文字输出规范**：向用户汇报 DSH 状态或追问确认时，只使用简洁、自然的中文句子；**禁止**输出选项编号列表、交互表单、Markdown 大表格或要求用户回复特定命令/ID。

2. **自然语言意图映射**：

   * 用户表示“同意 / 放行 / 批了 / 可以” → 先查最近上下文或调用 `dsh_list_status` 获取 `pendingId`，调用 `dsh_decide_approval(pendingId, "allowed-once")`（除非用户明确说“这个会话以后都放行”，才用 `allowed-session`）。

   * 用户表示“拒绝，改成 xxx” → 先调用 `dsh_decide_approval(pendingId, "rejected")`，再调用 `dsh_send_instruction(sessionId, "...")` 转达修改要求。

   * 用户直接回答了 DSH 的问题 → 将口语回答整理后调用 `dsh_answer_question(pendingId, ...)`。

   * 用户询问“DSH 现在怎么样了” → 调用 `dsh_list_status` 后用一两句纯文字概括。

3. **多任务防误批消歧**：当 `dsh_list_status` 返回 2 条及以上挂起请求，而用户只回复了模糊指令（如“同意”“可以”）时，**严禁猜测放行**，必须用一句自然中文反问确认用户指的是哪一个任务。

4. **高危操作二次口头确认**：若待审批命令涉及大范围删除（如 `rm -rf`）、覆盖关键配置或越界写入，即使在直推后用户回复“好”，也允许在存在歧义时复述命令核心影响再确认。

## 5. 必须规避的 DSH 底层技术坑（开发必读）

1. **禁止独占 `approval/request` 瀑布流导致 Web UI 饿死**：
   DSH 的 Web UI 审批依赖内置 Remote Forwarder 监听 `approval/request`。外部插件若注册全局监听且不调用 `next()`，会拦截并饿死 Web UI（[Discussion #9530](https://github.com/deepseek-ai/deepseek-harness/discussions/9530)）。必须使用 `Promise.race([next(), waitForHermes(id)])` 实现双端竞速，并在任一端先结单后清理另一端的等待状态。

2. **严禁通过 `agent.inject()` 回复 `ask_user_question`**：
   DSH 中 `ask_user_question` 绑定当前 Turn 的 `AbortController`，若在提问挂起期间往会话注入普通用户消息，会触发 `agent.cancel({ kind: 'user' })`，导致提问以 `ASK_ABORTED` 异常终止（[Discussion #3854](https://github.com/deepseek-ai/deepseek-harness/discussions/3854)）。必须在 `dsh_send_instruction` 中显式拦截“当前存在挂起提问”的情况，强制走 `dsh_answer_question`。

3. **防止双包依赖冲突（Dual-Package Hazard）**：
   `@deepseek-ai/cordis` 及其他 `@deepseek-ai/*` 宿主包必须声明为 `peerDependencies`，不可打包进插件自身的 `node_modules`，否则 Symbol 不匹配会导致事件监听静默失效（[Discussion #5325](https://github.com/deepseek-ai/deepseek-harness/discussions/5325)）。

4. **防止重复挂载报错（`duplicate loader entry id`）**：
   通过 `dsh plugin add` 安装带 `dsh.bundle.patch` 的插件后，不可在 Profile 的 `cordis.patch.yml` 中再次 `- insert:` 相同 `id`（[Discussion #2889](https://github.com/deepseek-ai/deepseek-harness/discussions/2889)）。本地开发期优先使用 `dsh --profile web --patch ./dev-patch.yml` 调试（[publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)）。

5. **进程重启后的过期请求处理**：
   DSH 的挂起审批与提问 `Promise` 仅存于内存，不跨进程重启持久化（[Discussion #6989](https://github.com/deepseek-ai/deepseek-harness/discussions/6989)）。MCP 工具遇到不存在的 `pendingId` 时必须返回明确的 `EXPIRED_OR_RESTARTED` 错误码，避免静默失败。

## 6. 验收标准与测试清单

| 编号 | 测试场景 | 预期结果 | 
| ----- | ----- | ----- | 
| AC-1 | DSH 触发 Auto Review / 沙箱审批拦截 | 3 秒内 Telegram 收到 Hermes 发出的自然语言纯文字通知；用户在 Telegram 回复“放行”后，DSH 任务自动继续执行 | 
| AC-2 | Web UI 与 Telegram 竞速审批 | 电脑端 Web UI 正常弹出审批卡片；在电脑端点击允许或拒绝后，DSH 正常继续，且之后在 Telegram 回复该条审批时返回“已处理/已过期” | 
| AC-3 | DSH 调用 `ask_user_question` | 即使浏览器标签页关闭，Telegram 仍能收到提问通知；用户纯文字回复答案后，DSH 收到回答并继续运行，**不触发 `ASK_ABORTED`** | 
| AC-4 | DSH 遇到 API 欠费（402）或限流（429） | Telegram 收到异常中断纯文字通知；60 秒内连续重试只推送一次，不刷屏 | 
| AC-5 | DSH 长任务正常完成 | Telegram 收到包含任务名与简要结果摘要的完成通知 | 
| AC-6 | 拒绝审批并改派新方案 | 用户在 Telegram 回复“别删目录，直接跑 pytest”，Hermes 先拒绝原审批再注入新指令，DSH 按新要求继续执行 | 
| AC-7 | 多任务同时挂起消歧 | 两个 DSH 会话同时等待审批，用户仅回复“同意”，Hermes 必须纯文字反问确认，不盲目放行 | 
| AC-8 | 超时与重启兜底 | 审批超过 `approvalTimeoutMs` 自动以 `rejected` 结束；DSH 重启后回复旧通知，Hermes 如实告知请求已失效 | 

## 7. 建议开发里程碑（供 Antigravity 执行）

* **Milestone 1（插件骨架与事件推送）**：搭建 `package.json`、`cordis.patch.yml`、`PendingStore`、`event-listeners.ts` 与 `webhook-client.ts`，完成 4 类事件的单元测试，并用 `dsh --profile web --patch` 在本机验证事件能推送到本地 mock HTTP server。

* **Milestone 2（本地 MCP Server 与双端联调）**：实现 `mcp-server.ts` 的 5 个工具与鉴权逻辑，编写单元测试验证 `Promise.race` 竞速、防 `ASK_ABORTED` 保护和 `EXPIRED_OR_RESTARTED` 兜底。

* **Milestone 3（Hermes 配置、Skill 与安装脚本）**：补齐 `hermes/skills/dsh-bridge/SKILL.md`、`hermes/config.example.yaml`、`scripts/setup-hermes.sh` 与 `README.md`，跑通端到端验收清单（AC-1 ～ AC-8）。