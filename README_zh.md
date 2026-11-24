# dsh-hermes-bridge

[English](./README.md) | 简体中文

同一台 Linux 工作站上 **DeepSeek Harness (DSH)** 与 **Hermes Agent** 的双向本地桥接插件，用于通过 Telegram 远程监管与自然语言控制本地 DSH 会话：

* **上行（DSH → Hermes → Telegram）**：监听 DSH 的审批请求（`approval/request`）、用户提问（`user-questions/request`）、模型/流异常中断（HTTP `402`/`429`/鉴权/流错误防抖）与 `turn/end` 结束事件。为每条消息分配易输入的短编号（`[#1]`、`[#2]`…），将单题/多题选择题格式化为带字母编号（`A` / `B` / `C`）和选项说明的清晰文本，通过 HMAC-SHA256 V2 签名 `POST` 到 Hermes 本地 Webhook 适配器（`mirror_to_session: true`）。
* **下行（Telegram → Hermes → DSH）**：用户在 Telegram 用自然的纯文字对话回复 Hermes，Hermes 依据内置 Skill（[`hermes/skills/dsh-bridge/SKILL.md`](./hermes/skills/dsh-bridge/SKILL.md)）与 MCP Tool Schema（提问回答会由 LLM 严格转换为固定 JSON Schema），调用本地 StreamableHTTP MCP Server（`http://127.0.0.1:8790/mcp`）暴露的 5 个工具驱动 DSH。
* **双端并发不互锁**：电脑端 DSH Web UI 与手机端 Telegram 通过 `Promise.race` 竞速响应，先响应者生效；Telegram 先响应时会自动取消下游 UI 的 `AbortSignal`，使 Web 端授权/提问弹窗同步关闭，既不阻塞也不饿死 Web UI。

---

## 目录结构

```text
dsh-hermes-bridge/
├── package.json                # DSH Cordis Bundle 插件清单（dsh.bundle.patch + peerDependencies）
├── cordis.patch.yml            # DSH 插件默认挂载配置
├── tsconfig.json
├── lib/                        # Git 跟踪提交的编译产物（无需安装期构建脚本）
├── src/
│   ├── index.ts                # Cordis 插件入口（name, inject, Config, apply）
│   ├── types.ts                # 协议与 DSH 宿主服务接口类型定义
│   ├── pending-store.ts        # 挂起审批/提问内存状态表、短编号、超时与严格回答 Schema 校验
│   ├── event-listeners.ts      # DSH 事件监听、错误防抖、UI 信号同步关闭与格式化摘要
│   ├── webhook-client.ts       # Hermes Webhook 客户端（幂等 X-Request-ID、HMAC-V2 签名、重试）
│   └── mcp-server.ts           # 本地 StreamableHTTP MCP Server（5 个反控工具与 /health）
├── tests/
│   ├── pending-store.test.ts
│   ├── event-listeners.test.ts
│   └── mcp-server.test.ts
├── hermes/
│   ├── skills/dsh-bridge/SKILL.md
│   └── config.example.yaml
└── scripts/
    └── setup-hermes.sh
```

---

## 快速开始

### 1. 构建与测试（本地开发）

```bash
pnpm install
npm run build
npm test
```

> **打包说明**：所有 `@deepseek-ai/*` 宿主包仅声明在 `peerDependencies`，核心代码不引入运行时第三方依赖，避免 Dual-Package Hazard。为适配 DSH 使用的 `pnpm` v12 供应链安全策略（禁止未列入 `allowBuilds` 的 Git 包执行 `prepare`/`prepack` 构建脚本），本仓库故意不写生命周期构建脚本，直接跟踪提交 `lib/` 编译产物；修改 `src/` 后请务必执行 `npm run build` 同步更新 `lib/`。

### 2. 配置 Hermes 侧（Skill + Webhook + MCP）

运行安装辅助脚本：

```bash
./scripts/setup-hermes.sh
```

脚本会完成：
1. 将 `hermes/skills/dsh-bridge` 软链至 `~/.hermes/skills/dsh-bridge`；
2. 生成随机 `DSH_HERMES_MCP_TOKEN` 与 `DSH_HERMES_WEBHOOK_SECRET`（如环境变量中已设置则直接复用）；
3. 输出可合并到 `~/.hermes/config.yaml` 的配置片段（完整模板与可选智能润色模式见 [`hermes/config.example.yaml`](./hermes/config.example.yaml)）；
4. 探测 `http://127.0.0.1:8644/health` 与 `http://127.0.0.1:8790/health` 连通状态。

合并配置后请重启 Hermes Gateway（如 `hermes gateway restart`），使 Webhook 路由、MCP Server 与最新工具 Schema 生效。

### 3. 安装并挂载到 DSH

先在 DSH 运行环境中设置共享密钥（或在对应 Profile 的 `cordis.patch.yml` 中按 `id: dsh-hermes-bridge` 覆写 `config`）：

```bash
export DSH_HERMES_MCP_TOKEN="<与 Hermes mcp_servers.dsh_bridge Authorization Bearer 一致>"
export DSH_HERMES_WEBHOOK_SECRET="<与 Hermes webhook secret 一致>"
```

* **方式 A：从 GitHub 直接安装到 Profile（推荐）**

  ```bash
  dsh plugin --profile web add "github:grubwithu/dsh-hermes-bridge#main"
  ```

  后续拉取最新提交：

  ```bash
  dsh plugin --profile web update dsh-hermes-bridge
  ```

* **方式 B：软链本地工作目录（适合高频本地开发调试）**

  ```bash
  dsh plugin --profile web add "link:/path/to/dsh-hermes-bridge"
  ```

* **方式 C：本地打包 `.tgz` 安装到 Profile**

  ```bash
  npm run build && npm pack
  dsh plugin --profile web add /path/to/dsh-hermes-bridge/dsh-hermes-bridge-0.1.0.tgz
  ```

  > **注意**：通过 `dsh plugin add` 安装带 `dsh.bundle.patch` 的插件后，DSH 会自动挂载它，无需再在 Profile 的 `cordis.patch.yml` 中重复写 `- insert: - id: dsh-hermes-bridge`（否则会触发 `duplicate loader entry id`）。如需覆写配置，只按 `id: dsh-hermes-bridge` 覆盖 `config` 即可。

* **方式 D：未安装时的本地临时 `--patch` 调试**

  新建一份本地 `dev-patch.local.yml`（已被 `.gitignore` 忽略），将 `name` 指向构建产物 `lib/index.js` 的绝对路径：

  ```yaml
  - insert:
      - id: dsh-hermes-bridge
        name: /path/to/dsh-hermes-bridge/lib/index.js
        config:
          mcpHost: "127.0.0.1"
          mcpPort: 8790
          hermesWebhookUrl: "http://127.0.0.1:8644/webhooks/dsh-events"
  ```

  启动 DSH：

  ```bash
  dsh --profile web --patch ./dev-patch.local.yml
  ```

---

## 配置项参考（`Config` / `cordis.patch.yml`）

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mcpHost` | `"127.0.0.1"` | MCP HTTP Server 监听地址（严格限定回环） |
| `mcpPort` | `8790` | MCP HTTP Server 监听端口（测试可设为 `0`） |
| `mcpAuthToken` | `""`（回退读 `DSH_HERMES_MCP_TOKEN`） | Bearer 鉴权密钥；为空时仅放行 loopback 并打印启动警告 |
| `hermesWebhookUrl` | `"http://127.0.0.1:8644/webhooks/dsh-events"` | Hermes Webhook 接收地址 |
| `hermesWebhookSecret` | `""`（回退读 `DSH_HERMES_WEBHOOK_SECRET`） | HMAC-SHA256 V2 签名密钥（`X-Webhook-Timestamp` + `X-Webhook-Signature-V2`） |
| `approvalTimeoutMs` | `300000` | 审批等待超时（5 分钟）；超时自动以 `rejected` 失败关闭，绝不自动放行 |
| `questionTimeoutMs` | `1800000` | 提问等待超时（30 分钟）；超时结束挂起等待 |
| `notifyOnTurnEndMinDurationMs` | `0`（`cordis.patch.yml` 默认 `10000`） | 正常完成 Turn 低于该耗时（毫秒）时不推送完成通知（`durationMs === 0` 时不吞通知） |
| `errorDebounceMs` | `60000` | 同会话同类型错误防抖窗口（60 秒） |

---

## MCP 工具一览

所有工具通过 `POST /mcp`（StreamableHTTP）暴露，并附带 `GET /health` 健康检查端点：

| 工具名 | 作用 |
| --- | --- |
| `dsh_list_status` | 列出挂起审批、挂起提问（含 `[#N]` 短编号与 `A`/`B`/`C` 选项编号）、活跃会话及可选的 `recentStopped` 最近结束 Turn。 |
| `dsh_decide_approval` | 按短编号（`#N` / `N`）或完整 `apr_xxxx` 决策 `allowed-once` / `allowed-session` / `rejected`；失效或重启返回 `EXPIRED_OR_RESTARTED`。 |
| `dsh_answer_question` | 按严格 JSON Schema `{ pendingId, answers: [{ questionIndex, selected, custom? }] }` 回答挂起的 `ask_user_question`（兼容普通 `open` 与超时续答 `continued` 模式），不触发 `ASK_ABORTED`。`selected` 仅接受合法选项字母或精确原文，校检不通过时返回 `INVALID_ANSWER_SCHEMA`，绝不静默丢入 `custom`。 |
| `dsh_send_instruction` | 向活跃会话注入新指令（`inject` / `followup` / `steer`）；若会话存在挂起提问则拒绝并提示先调用 `dsh_answer_question`。 |
| `dsh_cancel_session` | 中止指定会话的当前 Turn（`agent.cancel({ kind: "user" })`）。 |

---

## 核心行为与安全保障

* **消息短编号（`#1`、`#2`…）**：每条审批、提问、异常中断与完成通知都会分配顺序短编号（`shortId`），短时间内多会话并发请求时可直接按编号指代，避免混淆。
* **选择题结构化排版**：单题与多题提问均按统一格式展示题号、单选/多选标识、题干、字母选项（`A`/`B`/`C`）及每个选项的说明（`description`）。
* **LLM 严格转 Schema 回答**：用户在 Telegram 的自然语言回复由 Hermes LLM 负责解析并转换为固定 JSON Schema 后再调用 `dsh_answer_question`，服务端仅做严格字段校验与字母下标查表，确保结果可控、不误选。
* **Fail-Closed 与防抖**：审批超时默认拒绝；过期或 DSH 重启后的旧请求明确返回 `EXPIRED_OR_RESTARTED`；同类错误在防抖窗口内仅提醒一次。

---

## 许可证

MIT
