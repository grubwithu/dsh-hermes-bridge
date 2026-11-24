# dsh-hermes-bridge

English | [简体中文](./README_zh.md)

A bidirectional local bridge plugin between **DeepSeek Harness (DSH)** and **Hermes Agent** on the same Linux workstation, enabling remote Telegram supervision and natural-language control of local DSH sessions.

* **Upstream (DSH → Hermes → Telegram)**: Listens for DSH tool approval requests (`approval/request`), interactive user questions (`user-questions/request`), debounced LLM/stream failures (HTTP `402`/`429`/auth/stream errors), and `turn/end` completions. Assigns sequential short request numbers (`[#1]`, `[#2]`, …), formats multiple-choice questions with lettered options (`A`, `B`, `C`) and option descriptions, and pushes payloads signed with HMAC-SHA256 V2 to Hermes's local webhook adapter (`mirror_to_session: true`).
* **Downstream (Telegram → Hermes → DSH)**: Reply to Hermes in plain natural language on Telegram. Hermes (guided by [`hermes/skills/dsh-bridge/SKILL.md`](./hermes/skills/dsh-bridge/SKILL.md) and the MCP tool schemas) converts your intent—including mapping question replies into a strict JSON Schema—and invokes one of 5 tools on the local StreamableHTTP MCP Server (`http://127.0.0.1:8790/mcp`).
* **Concurrent Dual-Surface Racing**: Desktop DSH Web UI and Telegram race via `Promise.race`. Whichever surface responds first wins and settles the pending store; when Telegram answers first, the bridge aborts the downstream UI `AbortSignal` so the browser modal closes immediately without starving or breaking the Web UI.

---

## Architecture & Directory Layout

```text
dsh-hermes-bridge/
├── package.json                # DSH Cordis bundle manifest (dsh.bundle.patch + peerDependencies)
├── cordis.patch.yml            # Default DSH bundle Cordis patch configuration
├── tsconfig.json
├── lib/                        # Tracked compiled JS & .d.ts outputs (no install-time build script needed)
├── src/
│   ├── index.ts                # Cordis plugin entrypoint (name, inject, Config schema, apply)
│   ├── types.ts                # Bridge & DSH host service TypeScript interfaces
│   ├── pending-store.ts        # Pending approvals/questions store, short IDs, timeouts, strict answer validator
│   ├── event-listeners.ts      # DSH event listeners, debounce, UI signal cancellation, summary formatting
│   ├── webhook-client.ts       # Hermes Webhook client (idempotent X-Request-ID, HMAC-SHA256 V2, retries)
│   └── mcp-server.ts           # Loopback StreamableHTTP MCP Server (5 control tools + /health)
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

## Quick Start

### 1. Build & Test (for local development)

```bash
pnpm install
npm run build
npm test
```

> **Packaging Note**: All `@deepseek-ai/*` host packages are declared solely under `peerDependencies`, and the plugin has zero runtime `dependencies` to avoid Dual-Package Hazard. Because DSH uses `pnpm` v12's strict supply-chain policy (which blocks `prepare`/`prepack` build scripts for git-hosted packages unless explicitly listed in `allowBuilds`), this repository intentionally omits lifecycle build scripts and tracks compiled artifacts under `lib/` directly in Git. Whenever you edit files under `src/`, run `npm run build` so `lib/` stays in sync.

### 2. Configure Hermes (Skill + Webhook + MCP)

Run the setup helper script:

```bash
./scripts/setup-hermes.sh
```

This script:
1. Symlinks `hermes/skills/dsh-bridge` to `~/.hermes/skills/dsh-bridge`;
2. Generates random `DSH_HERMES_MCP_TOKEN` and `DSH_HERMES_WEBHOOK_SECRET` values (or reuses values already exported in your environment);
3. Prints the configuration snippet to merge into `~/.hermes/config.yaml` (see [`hermes/config.example.yaml`](./hermes/config.example.yaml) for the full template, including optional LLM-polished mode);
4. Probes `http://127.0.0.1:8644/health` and `http://127.0.0.1:8790/health`.

After updating `~/.hermes/config.yaml`, restart the Hermes Gateway (e.g., `hermes gateway restart`) so the webhook route, MCP server, and updated tool schemas take effect.

### 3. Install & Mount in DSH

Export the shared secrets in the environment where DSH runs (or override `config` for `id: dsh-hermes-bridge` in your profile's `cordis.patch.yml`):

```bash
export DSH_HERMES_MCP_TOKEN="<matches Hermes mcp_servers.dsh_bridge Authorization Bearer token>"
export DSH_HERMES_WEBHOOK_SECRET="<matches Hermes webhook route secret>"
```

* **Option A: Install directly from GitHub into a DSH profile (Recommended)**

  ```bash
  dsh plugin --profile web add "github:grubwithu/dsh-hermes-bridge#main"
  ```

  To pull new commits later:

  ```bash
  dsh plugin --profile web update dsh-hermes-bridge
  ```

* **Option B: Link local working copy (Best for active plugin development)**

  ```bash
  dsh plugin --profile web add "link:/path/to/dsh-hermes-bridge"
  ```

* **Option C: Pack a local `.tgz` tarball**

  ```bash
  npm run build && npm pack
  dsh plugin --profile web add /path/to/dsh-hermes-bridge/dsh-hermes-bridge-0.1.0.tgz
  ```

  > **Important**: Because this package declares `dsh.bundle.patch` in `package.json`, installing it via `dsh plugin add` mounts it automatically. Do **not** add another `- insert: - id: dsh-hermes-bridge` entry in your profile's `cordis.patch.yml` (which causes `duplicate loader entry id`). To customize plugin config per profile, patch the existing entry by `id: dsh-hermes-bridge`.

* **Option D: Ephemeral `--patch` debugging without installing**

  Create a local `dev-patch.local.yml` (gitignored) pointing `name` to the absolute path of `lib/index.js`:

  ```yaml
  - insert:
      - id: dsh-hermes-bridge
        name: /path/to/dsh-hermes-bridge/lib/index.js
        config:
          mcpHost: "127.0.0.1"
          mcpPort: 8790
          hermesWebhookUrl: "http://127.0.0.1:8644/webhooks/dsh-events"
  ```

  Launch DSH with:

  ```bash
  dsh --profile web --patch ./dev-patch.local.yml
  ```

---

## Configuration Reference (`Config` / `cordis.patch.yml`)

| Option | Default | Description |
| --- | --- | --- |
| `mcpHost` | `"127.0.0.1"` | Bind address for the MCP HTTP server (loopback only when auth token is empty) |
| `mcpPort` | `8790` | Listening port for the MCP HTTP server (`0` for ephemeral port in tests) |
| `mcpAuthToken` | `""` (fallback: `DSH_HERMES_MCP_TOKEN`) | Bearer token for `POST /mcp`; if empty, non-loopback requests are rejected with `403` and a startup warning is logged |
| `hermesWebhookUrl` | `"http://127.0.0.1:8644/webhooks/dsh-events"` | Target URL of Hermes's local webhook receiver |
| `hermesWebhookSecret` | `""` (fallback: `DSH_HERMES_WEBHOOK_SECRET`) | HMAC-SHA256 V2 secret (`X-Webhook-Timestamp` + `X-Webhook-Signature-V2`) |
| `approvalTimeoutMs` | `300000` | Timeout (ms) waiting for an approval decision (5 min); fails closed as `rejected` |
| `questionTimeoutMs` | `1800000` | Timeout (ms) waiting for a user question answer (30 min) |
| `notifyOnTurnEndMinDurationMs` | `0` (`10000` in `cordis.patch.yml`) | Minimum turn duration (ms) to emit a `stopped` webhook on normal completion (`durationMs === 0` is never suppressed) |
| `errorDebounceMs` | `60000` | Per-session, per-error-category debounce window (60s) |

---

## MCP Tools Exposed by `dsh-hermes-bridge`

All tools are served over StreamableHTTP at `POST /mcp` (plus `GET /health` for readiness checks):

| Tool | Purpose |
| --- | --- |
| `dsh_list_status` | Lists all pending approvals, pending user questions (with `[#N]` short IDs and `A`/`B`/`C` option codes), active DSH sessions, and optional `recentStopped` turns. |
| `dsh_decide_approval` | Approves (`allowed-once` or `allowed-session`) or rejects (`rejected`) a pending approval by `#N`, `N`, or full `apr_xxxx` ID. Returns `EXPIRED_OR_RESTARTED` if already settled or restarted. |
| `dsh_answer_question` | Submits an answer to a pending `ask_user_question` prompt (both `open` and timed `continued` modes) using a strict JSON Schema: `{ pendingId, answers: [{ questionIndex, selected, custom? }] }`. `selected` accepts exact option letters (`"A"`, `"B"`, …) or exact labels and validates single/multi-select rules strictly without silently falling back to `custom`. |
| `dsh_send_instruction` | Sends a follow-up user message (`inject` / `followup` / `steer`) to a live DSH session. Refuses with `PENDING_QUESTION_EXISTS` if the session has an unanswered question to prevent triggering `ASK_ABORTED`. |
| `dsh_cancel_session` | Cancels the active turn of a DSH session (`agent.cancel({ kind: "user" })`). |

---

## Key Behaviors & Design Guarantees

* **Short Request Numbers (`#1`, `#2`, …)**: Every notification (`paused_approval`, `paused_question`, `interrupted_error`, `stopped`) carries a short sequence identifier (`shortId`), making it easy to disambiguate or reference specific requests when multiple sessions pause around the same time.
* **Structured Multiple-Choice Rendering**: Both single-question and multi-question prompts render each question with its index, single/multi-select tag, prompt text, lettered options (`A`, `B`, `C`, …), and option descriptions.
* **Strict LLM-to-Schema Question Answering**: Hermes LLM translates the user's natural-language reply into `{ pendingId, answers: [{ questionIndex, selected, custom? }] }`. The server strictly validates question count, single-select constraints, and option letters/labels (returning `INVALID_ANSWER_SCHEMA` with valid choices on mismatch).
* **Fail-Closed & Stale-Safe**: Approvals time out as `rejected`; stale or post-restart actions return `EXPIRED_OR_RESTARTED`; duplicate LLM rate-limit/quota errors (`429`/`402`) are debounced within `errorDebounceMs`.

---

## License

MIT
