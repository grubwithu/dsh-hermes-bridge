# dsh-hermes-bridge

同一台 Linux 工作站上 **DeepSeek Harness (DSH)** 与 **Hermes Agent** 的双向本地桥接插件：

* **上行（DSH → Hermes → Telegram）**：监听 DSH 的审批请求（`approval/request`）、用户提问（`user-questions/request`）、模型异常中断（402/429/流错误防抖）与 Turn 结束事件，通过 HMAC-V2 签名 `POST` 到 Hermes 本地 Webhook 适配器，并开启 `mirror_to_session: true` 写入 Telegram 会话历史。
* **下行（Telegram → Hermes → DSH）**：用户在 Telegram 用最自然的中文纯文字对话回复 Hermes，Hermes 依据内置 Skill（`hermes/skills/dsh-bridge/SKILL.md`）调用本地 StreamableHTTP MCP Server（`http://127.0.0.1:8790/mcp`）暴露的 5 个工具，驱动 DSH 审批放行/拒绝、回答提问、注入新指令或中止任务。
* **双端并发不互锁**：电脑端 DSH Web UI 与手机端 Telegram 通过 `Promise.race` 竞速审批/回答，先响应者生效；不覆盖或饿死 Web UI。

---

## 目录结构

```
dsh-hermes-bridge/
├── package.json                # DSH Cordis Bundle 插件清单（dsh.bundle.patch + peerDependencies）
├── cordis.patch.yml            # DSH 插件默认挂载配置
├── tsconfig.json
├── src/
│   ├── index.ts                # Cordis 插件入口（name, inject, Config, apply）
│   ├── types.ts                # 协议与 DSH 宿主接口类型定义
│   ├── pending-store.ts        # 挂起审批/提问内存状态表与超时管理
│   ├── event-listeners.ts      # DSH 四类事件监听与防抖/竞速逻辑
│   ├── webhook-client.ts       # Hermes Webhook 推送客户端（幂等 ID、HMAC-V2 签名、重试）
│   └── mcp-server.ts           # 本地 StreamableHTTP MCP Server（5 个反控工具）
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

### 1. 构建插件

```bash
pnpm install
npm run build
npm test
```

> 所有 `@deepseek-ai/*` 宿主包仅声明在 `peerDependencies`，且核心代码不引入运行时第三方包，避免 Dual-Package Hazard；同时 `lib/` 构建产物会提交到 Git 仓库，确保通过 `dsh plugin add "github:..."` 安装时即便宿主 `pnpm` 默认跳过构建脚本（`allowBuilds`）也能直接加载入口。

### 2. 配置 Hermes 侧（Skill + Webhook + MCP）

运行安装辅助脚本：

```bash
./scripts/setup-hermes.sh
```

脚本会完成：
1. 将 `hermes/skills/dsh-bridge` 软链至 `~/.hermes/skills/dsh-bridge`；
2. 生成随机 `DSH_HERMES_MCP_TOKEN` 与 `DSH_HERMES_WEBHOOK_SECRET`；
3. 输出可合并到 `~/.hermes/config.yaml` 的配置片段（完整模板见 [hermes/config.example.yaml](hermes/config.example.yaml)）；
4. 探测 `127.0.0.1:8644/health` 与 `127.0.0.1:8790/health` 连通状态。

合并配置后重启 Hermes Gateway，使 Webhook 与 MCP Server 生效。

### 3. 挂载到 DSH

先在 DSH 运行环境中设置共享密钥（例如写入 `~/.dsh/.env`，或在 Profile 的 `cordis.patch.yml` 中按 `id: dsh-hermes-bridge` 覆写 `config`）：

```bash
export DSH_HERMES_MCP_TOKEN="<与 Hermes mcp_servers.dsh_bridge 一致>"
export DSH_HERMES_WEBHOOK_SECRET="<与 Hermes webhook secret 一致>"
```

* **方式 A：从 GitHub 直接安装到 Profile（推荐）**：

  ```bash
  dsh plugin --profile web add "github:grubwithu/dsh-hermes-bridge#main"
  ```

* **方式 B：本地打包 `.tgz` 安装到 Profile**：

  ```bash
  npm run build && npm pack
  dsh plugin --profile web add /mnt/hd/users/grub/dsh-hermes-bridge/dsh-hermes-bridge-0.1.0.tgz
  ```

  > 注意：通过 `dsh plugin add` 安装带 `dsh.bundle.patch` 的插件后，无需再在 Profile 的 `cordis.patch.yml` 中重复 `- insert: id: dsh-hermes-bridge`，否则会触发 `duplicate loader entry id`。若需覆盖默认配置（如设置密钥），仅按 `- id: dsh-hermes-bridge` 覆写 `config` 字段即可。

* **方式 C：未安装时的本地临时 `--patch` 调试**：

  [cordis.patch.yml](cordis.patch.yml) 中的 `name: dsh-hermes-bridge` 仅在安装进 Profile 后通过包名解析；若未执行 `dsh plugin add` 而直接临时调试，请新建一份本地 `dev-patch.local.yml`（已被 `.gitignore` 忽略），将 `name` 指向构建产物绝对路径：

  ```yaml
  - insert:
      - id: dsh-hermes-bridge
        name: /mnt/hd/users/grub/dsh-hermes-bridge/lib/index.js
        config:
          mcpHost: "127.0.0.1"
          mcpPort: 8790
          hermesWebhookUrl: "http://127.0.0.1:8644/webhooks/dsh-events"
  ```

  然后启动：

  ```bash
  dsh --profile web --patch ./dev-patch.local.yml
  ```

---

## 配置项参考（`cordis.patch.yml`）

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mcpHost` | `"127.0.0.1"` | MCP HTTP Server 监听地址（严格限定回环） |
| `mcpPort` | `8790` | MCP HTTP Server 监听端口 |
| `mcpAuthToken` | `""`（回退读 `DSH_HERMES_MCP_TOKEN`） | Bearer 鉴权密钥；为空时仅放行 loopback 并打印启动警告 |
| `hermesWebhookUrl` | `"http://127.0.0.1:8644/webhooks/dsh-events"` | Hermes Webhook 接收地址 |
| `hermesWebhookSecret` | `""`（回退读 `DSH_HERMES_WEBHOOK_SECRET`） | HMAC-SHA256 V2 签名密钥（`X-Webhook-Timestamp` + `X-Webhook-Signature-V2`） |
| `approvalTimeoutMs` | `300000` | 审批等待超时（5 分钟）；超时自动以 `rejected` 结束，绝不放行 |
| `questionTimeoutMs` | `1800000` | 提问等待超时（30 分钟）；超时结束挂起等待 |
| `notifyOnTurnEndMinDurationMs` | `10000` | 正常完成 Turn 低于该耗时（10 秒）时不推完成通知 |
| `errorDebounceMs` | `60000` | 同会话同类型错误防抖窗口（60 秒） |

---

## MCP 工具一览

| 工具名 | 作用 |
| --- | --- |
| `dsh_list_status` | 列出挂起审批、挂起提问、活跃会话及可选的最近结束 Turn |
| `dsh_decide_approval` | 按 `pendingId` 决策 `allowed-once` / `allowed-session` / `rejected`；失效返回 `EXPIRED_OR_RESTARTED` |
| `dsh_answer_question` | 按 `pendingId` 回答 `ask_user_question`（兼容普通与 `continued` 续答模式），不触发 `ASK_ABORTED` |
| `dsh_send_instruction` | 向指定会话注入新指令；若该会话有挂起提问则拒绝并提示先调用 `dsh_answer_question` |
| `dsh_cancel_session` | 中止指定会话的当前 Turn（`agent.cancel({ kind: 'user' })`） |

---

## 验收场景清单（AC-1 ～ AC-8）

* **AC-1**：DSH 触发审批拦截 → Webhook 上报至 Hermes → 用户在 Telegram 回复纯文字放行 → DSH 继续执行。
* **AC-2**：Web UI 与 Telegram 竞速审批 → 电脑端先决策后清理挂起表 → Telegram 后续回复收到失效提示（`EXPIRED_OR_RESTARTED`）。
* **AC-3**：无浏览器连接时触发 `ask_user_question` → Telegram 收到提问 → 用户回复答案后 DSH 正常继续且不触发 `ASK_ABORTED`。
* **AC-4**：API 402/429/流错误 → 60 秒窗口内同一会话同类错误仅推送一次。
* **AC-5**：长任务 Turn 正常完成 → 推送含任务标题与助手摘要（≤ 500 字符）的通知。
* **AC-6**：拒绝审批并改派方案 → 先 `dsh_decide_approval(..., "rejected")` 再 `dsh_send_instruction(...)`。
* **AC-7**：多任务同时挂起 → Skill 强制 Hermes 反问澄清，禁止盲目放行。
* **AC-8**：审批超时自动 `rejected`；进程重启后旧通知请求返回 `EXPIRED_OR_RESTARTED`。
