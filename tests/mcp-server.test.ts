import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apply, inject, PendingStore, BridgeMcpServer } from "../lib/index.js";
import type {
  AskUserQuestionAnswer,
  DshAgent,
  DshContext,
  DshSession,
  DshUserMessage,
} from "../lib/types.js";

function createTestContext(options?: {
  injectedKeys?: ReadonlyArray<string>;
}) {
  const agents = new Map<string, DshAgent>();
  const sessions = new Map<string, DshSession>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const effects: Array<() => unknown> = [];
  const answeredContinued: Array<{ sessionId: string; callId: string; answer: AskUserQuestionAnswer }> = [];

  const allowedServices = new Set<string>(options?.injectedKeys ?? inject);

  const rawCtx: DshContext = {
    on(name, listener) {
      const list = handlers.get(name) ?? [];
      list.push(listener);
      handlers.set(name, list);
      return () => true;
    },
    effect(cb) {
      const cleanup = cb();
      if (typeof cleanup === "function") {
        effects.push(cleanup);
      }
      return () => {};
    },
    logger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    },
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    sessionTitle: {
      get: (session) => ({ title: `Title(${session.id})` }),
    },
    userQuestions: {
      answer(agent, callId, answer) {
        answeredContinued.push({ sessionId: agent.id, callId, answer });
        return true;
      },
    },
  };

  // Simulate Cordis's strict Context Proxy that throws when accessing an uninjected service
  const SERVICE_KEYS = new Set(["agents", "sessions", "userQuestions", "sessionTitle"]);
  const ctx = new Proxy(rawCtx, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && SERVICE_KEYS.has(prop) && !allowedServices.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return { ctx, agents, sessions, effects, answeredContinued };
}

async function rpcPost(
  baseUrl: string,
  body: unknown,
  token?: string,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; json: any; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: resp.status, headers: resp.headers, json, text };
}

function parseToolResult(rpcResponse: any): any {
  const content = rpcResponse?.result?.content;
  assert.ok(Array.isArray(content) && content.length > 0);
  return JSON.parse(content[0].text);
}

describe("BridgeMcpServer", () => {
  it("supports StreamableHTTP MCP handshake, Bearer auth, health check, and 5 tools", async () => {
    const { ctx, agents, sessions } = createTestContext();
    const store = new PendingStore();

    const injectedRunning: DshUserMessage[] = [];
    const followupIdle: DshUserMessage[] = [];
    const cancelledCalls: Array<{ kind: string }> = [];

    const session1: DshSession = { id: "sess_1", header: { id: "sess_1", cwd: "/tmp/repo1" } };
    const session2: DshSession = { id: "sess_2", header: { id: "sess_2", cwd: "/tmp/repo2" } };
    sessions.set("sess_1", session1);
    sessions.set("sess_2", session2);

    const agent1: DshAgent = {
      id: "sess_1",
      session: session1,
      status: "running",
      inject: (msg) => injectedRunning.push(msg),
      cancel: (cause) => cancelledCalls.push(cause),
    };
    const agent2: DshAgent = {
      id: "sess_2",
      session: session2,
      status: "idle",
      followup: (msg) => followupIdle.push(msg),
      cancel: (cause) => cancelledCalls.push(cause),
    };
    agents.set("sess_1", agent1);
    agents.set("sess_2", agent2);

    const server = new BridgeMcpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret-mcp-token",
      ctx,
      store,
    });
    const addr = await server.start();
    const baseUrl = `http://${addr.host}:${addr.port}`;

    try {
      // Health endpoint
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json() as any).status, "ok");

      // Auth check
      const unauth = await rpcPost(baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" });
      assert.equal(unauth.status, 401);
      const wrongAuth = await rpcPost(baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong");
      assert.equal(wrongAuth.status, 401);

      // GET /mcp -> 405
      const getMcp = await fetch(`${baseUrl}/mcp`, {
        headers: { Authorization: "Bearer secret-mcp-token" },
      });
      assert.equal(getMcp.status, 405);

      // Initialize
      const init = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "hermes-test", version: "1.0" },
          },
        },
        "secret-mcp-token",
      );
      assert.equal(init.status, 200);
      const mcpSid = init.headers.get("mcp-session-id");
      assert.ok(mcpSid);
      assert.equal(init.json.result.capabilities.tools.listChanged, false);

      // Notification -> 202
      const notif = await rpcPost(
        baseUrl,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        "secret-mcp-token",
        mcpSid,
      );
      assert.equal(notif.status, 202);

      // tools/list -> 5 tools
      const listed = await rpcPost(
        baseUrl,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        "secret-mcp-token",
        mcpSid,
      );
      assert.equal(listed.status, 200);
      const toolNames = listed.json.result.tools.map((t: any) => t.name);
      assert.deepEqual(toolNames, [
        "dsh_list_status",
        "dsh_decide_approval",
        "dsh_answer_question",
        "dsh_send_instruction",
        "dsh_cancel_session",
      ]);

      // AC-7: Multiple pending items across sessions
      const apr1 = store.addApproval({
        sessionId: "sess_1",
        taskTitle: "Title(sess_1)",
        cwd: "/tmp/repo1",
        toolName: "bash",
        argumentsPreview: "rm -rf build/cache",
        timeoutMs: 5_000,
      });
      const qst2 = store.addQuestion({
        sessionId: "sess_2",
        taskTitle: "Title(sess_2)",
        cwd: "/tmp/repo2",
        questions: [{ id: "q1", question: "Pick env?" }],
        timeoutMs: 5_000,
      });
      store.recordStopped({
        sessionId: "sess_old",
        taskTitle: "Old Task",
        cwd: "/tmp",
        reasonKind: "completed",
        durationMs: 15_000,
        summary: "finished",
        stoppedAt: new Date().toISOString(),
      });

      const statusResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "dsh_list_status", arguments: { includeRecentStopped: true } },
        },
        "secret-mcp-token",
        mcpSid,
      );
      const statusPayload = parseToolResult(statusResp.json);
      assert.equal(statusPayload.pendingApprovals.length, 1);
      assert.equal(statusPayload.pendingQuestions.length, 1);
      assert.equal(statusPayload.activeSessions.length, 2);
      assert.equal(statusPayload.recentStopped.length, 1);

      // AC-6: Reject approval on sess_1, then send new instruction
      const rejectResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "dsh_decide_approval",
            arguments: { pendingId: apr1.pendingId, decision: "rejected", reason: "别删目录" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      assert.equal(parseToolResult(rejectResp.json).ok, true);
      assert.equal(await apr1.promise, "rejected");

      const injectResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "dsh_send_instruction",
            arguments: { sessionId: "sess_1", message: "别删目录，直接跑 pytest" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      const injectPayload = parseToolResult(injectResp.json);
      assert.equal(injectPayload.ok, true);
      assert.equal(injectPayload.deliveryMethod, "inject");
      assert.equal(injectedRunning.length, 1);
      assert.equal(injectedRunning[0]!.content[0]?.text, "别删目录，直接跑 pytest");
      assert.equal(Object.isFrozen(injectedRunning[0]), true);

      // Pitfall #2: Refuse dsh_send_instruction when sess_2 has a pending question!
      const blockedResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "dsh_send_instruction",
            arguments: { sessionId: "sess_2", message: "staging" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      const blockedPayload = parseToolResult(blockedResp.json);
      assert.equal(blockedPayload.ok, false);
      assert.equal(blockedPayload.code, "PENDING_QUESTION_EXISTS");
      assert.equal(followupIdle.length, 0);

      // Answer the pending question properly (using short number "#2"), then send instruction to idle agent -> uses followup
      const answerResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "dsh_answer_question",
            arguments: { pendingId: "#2", answerText: "staging" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      assert.equal(parseToolResult(answerResp.json).ok, true);
      assert.deepEqual(await qst2.promise, {
        answers: [{ id: "q1", selected: [], custom: "staging" }],
      });

      const wakeupResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "dsh_send_instruction",
            arguments: { sessionId: "sess_2", message: "顺便跑一下 smoke test" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      const wakeupPayload = parseToolResult(wakeupResp.json);
      assert.equal(wakeupPayload.ok, true);
      assert.equal(wakeupPayload.deliveryMethod, "followup");
      assert.equal(followupIdle.length, 1);

      // AC-8: Stale pendingId returns EXPIRED_OR_RESTARTED
      const staleResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "dsh_decide_approval",
            arguments: { pendingId: "apr_nonexistent", decision: "allowed-once" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      assert.deepEqual(parseToolResult(staleResp.json), {
        ok: false,
        code: "EXPIRED_OR_RESTARTED",
        message:
          'Approval request "apr_nonexistent" is no longer pending (already decided, timed out, or DSH restarted).',
      });

      // Cancel session
      const cancelResp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "dsh_cancel_session",
            arguments: { sessionId: "sess_1", reason: "用户取消" },
          },
        },
        "secret-mcp-token",
        mcpSid,
      );
      assert.equal(parseToolResult(cancelResp.json).cancelled, true);
      assert.deepEqual(cancelledCalls, [{ kind: "user" }]);

      // DELETE /mcp
      const del = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer secret-mcp-token",
          "Mcp-Session-Id": mcpSid,
        },
      });
      assert.equal(del.status, 200);
    } finally {
      store.dispose();
      await server.stop();
    }
  });

  it("wires apply(ctx, config) and cleans up cleanly on dispose", async () => {
    assert.deepEqual(inject, ["agents", "sessions", "userQuestions", "sessionTitle"]);
    const { ctx } = createTestContext();
    const runtime = apply(ctx, { mcpPort: 0 });
    await new Promise((r) => setTimeout(r, 30));
    const addr = runtime.mcpServer.getAddress();
    assert.ok(addr && addr.port > 0);

    const health = await fetch(`http://${addr.host}:${addr.port}/health`);
    assert.equal(health.status, 200);

    await runtime.dispose();
    assert.equal(runtime.mcpServer.getAddress(), null);
  });

  it("answers open-mode questions even on a strict Cordis Proxy ctx where userQuestions is not injected", async () => {
    const { ctx } = createTestContext({ injectedKeys: ["agents", "sessions"] });
    const store = new PendingStore();
    const server = new BridgeMcpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "token-strict",
      ctx,
      store,
    });
    const addr = await server.start();
    const baseUrl = `http://${addr.host}:${addr.port}`;

    try {
      const q = store.addQuestion({
        sessionId: "sess_strict",
        taskTitle: "Strict Proxy Task",
        cwd: "/tmp/strict",
        questions: [
          {
            id: "framework",
            question: "Which test runner?",
            options: [{ label: "Vitest" }, { label: "Node Test" }],
          },
        ],
        timeoutMs: 5_000,
      });

      const resp = await rpcPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "dsh_answer_question",
            arguments: { pendingId: "1", answerText: "Node Test" },
          },
        },
        "token-strict",
      );
      assert.equal(resp.status, 200);
      const result = parseToolResult(resp.json);
      assert.equal(result.ok, true);
      assert.equal(result.pendingId, q.pendingId);
      assert.deepEqual(await q.promise, {
        answers: [{ id: "framework", selected: ["Node Test"] }],
      });
    } finally {
      store.dispose();
      await server.stop();
    }
  });
});
