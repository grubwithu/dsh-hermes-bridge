import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PendingStore } from "../lib/pending-store.js";
import { WebhookClient } from "../lib/webhook-client.js";
import { registerEventListeners } from "../lib/event-listeners.js";
import type {
  AskUserQuestionAnswer,
  BridgeConfig,
  BridgeLogger,
  BridgeWebhookPayload,
  DshAgent,
  DshApprovalOutcome,
  DshApprovalRequestEvent,
  DshContext,
  DshSession,
  DshUserQuestionRequestEvent,
} from "../lib/types.js";

class MockDshContext implements DshContext {
  private readonly listeners = new Map<
    string,
    Array<{ callback: (...args: any[]) => any; prepend?: boolean; global?: boolean }>
  >();

  public readonly agentsList: DshAgent[] = [];
  public readonly sessionsList: DshSession[] = [];
  public readonly titles = new Map<string, string>();
  public readonly answeredContinued: Array<{ sessionId: string; callId: string; answer: AskUserQuestionAnswer }> = [];

  agents = {
    get: (id: string) => this.agentsList.find((a) => a.id === id),
    list: () => [...this.agentsList],
  };

  sessions = {
    get: (id: string) => this.sessionsList.find((s) => s.id === id),
    list: () => [...this.sessionsList],
  };

  sessionTitle = {
    get: (session: DshSession) => {
      const title = this.titles.get(session.id);
      return title ? { title } : undefined;
    },
  };

  userQuestions = {
    answer: (agent: DshAgent, callId: string, answer: AskUserQuestionAnswer) => {
      this.answeredContinued.push({ sessionId: agent.id, callId, answer });
      return true;
    },
  };

  on(
    name: string,
    listener: (...args: any[]) => any,
    options?: boolean | { prepend?: boolean; global?: boolean },
  ): () => boolean {
    const opts = typeof options === "boolean" ? { prepend: options } : options ?? {};
    const list = this.listeners.get(name) ?? [];
    const entry = { callback: listener, prepend: opts.prepend, global: opts.global };
    if (opts.prepend) {
      list.unshift(entry);
    } else {
      list.push(entry);
    }
    this.listeners.set(name, list);
    return () => {
      const cur = this.listeners.get(name) ?? [];
      const idx = cur.indexOf(entry);
      if (idx >= 0) {
        cur.splice(idx, 1);
        return true;
      }
      return false;
    };
  }

  emit(name: string, ...args: any[]): void {
    for (const entry of [...(this.listeners.get(name) ?? [])]) {
      entry.callback(...args);
    }
  }

  waterfall<T>(name: string, arg: any, fallbackNext: () => Promise<T>): Promise<T> {
    const chain = [...(this.listeners.get(name) ?? [])];
    const dispatch = (index: number): Promise<T> => {
      const entry = chain[index];
      if (!entry) {
        return fallbackNext();
      }
      return Promise.resolve(entry.callback(arg, () => dispatch(index + 1)));
    };
    return dispatch(0);
  }
}

const silentLogger: BridgeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    mcpHost: "127.0.0.1",
    mcpPort: 8790,
    mcpAuthToken: "mcp-secret",
    hermesWebhookUrl: "http://127.0.0.1:8644/webhooks/dsh-events",
    hermesWebhookSecret: "wh-secret-123",
    approvalTimeoutMs: 5_000,
    questionTimeoutMs: 5_000,
    notifyOnTurnEndMinDurationMs: 10_000,
    errorDebounceMs: 60_000,
    ...overrides,
  };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  payload: BridgeWebhookPayload;
}

function makeCapturingFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "");
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    captured.push({
      url: String(input),
      headers,
      rawBody,
      payload: JSON.parse(rawBody) as BridgeWebhookPayload,
    });
    return new Response(JSON.stringify({ status: "delivered" }), { status: 200 });
  }) as typeof fetch;
}

describe("WebhookClient", () => {
  it("signs payloads with Hermes HMAC-V2 and retries transient failures with the same X-Request-ID", async () => {
    const attempts: Array<{ id: string; sig: string; ts: string; body: string }> = [];
    let callCount = 0;

    const mockFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = init?.headers as Record<string, string>;
      attempts.push({
        id: headers["X-Request-ID"] ?? "",
        sig: headers["X-Webhook-Signature-V2"] ?? "",
        ts: headers["X-Webhook-Timestamp"] ?? "",
        body: String(init?.body ?? ""),
      });
      if (callCount === 1) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const client = new WebhookClient({
      url: "http://127.0.0.1:8644/webhooks/dsh-events",
      secret: "top-secret",
      logger: silentLogger,
      fetchImpl: mockFetch,
      retryDelaysMs: [1],
    });

    const res = await client.send({
      sessionId: "sess_a",
      taskTitle: "SyncFuzz",
      cwd: "/tmp/syncfuzz",
      state: "stopped",
      stateLabel: "任务已完成",
      summary: "全部完成",
      details: { durationMs: 12000 },
    });

    assert.equal(res.ok, true);
    assert.equal(res.attempts, 2);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.id, attempts[1]?.id);

    const expectedHex = createHmac("sha256", "top-secret")
      .update(`${attempts[1]!.ts}.${attempts[1]!.body}`, "utf8")
      .digest("hex");
    assert.equal(attempts[1]!.sig, expectedHex);

    // 401 should not retry
    let authCalls = 0;
    const authFailClient = new WebhookClient({
      url: "http://127.0.0.1:8644/webhooks/dsh-events",
      secret: "wrong",
      logger: silentLogger,
      fetchImpl: (async () => {
        authCalls++;
        return new Response("bad sig", { status: 401 });
      }) as typeof fetch,
      retryDelaysMs: [1],
    });
    const failRes = await authFailClient.send({
      sessionId: "sess_a",
      taskTitle: "SyncFuzz",
      cwd: "/tmp",
      state: "stopped",
      stateLabel: "任务已完成",
      summary: "x",
      details: {},
    });
    assert.equal(failRes.ok, false);
    assert.equal(authCalls, 1);
  });
});

describe("Event Listeners - AC-1 through AC-5", () => {
  it("AC-1 & AC-2: handles approval waterfall, HMAC webhook, Web UI race, and allowed-session", async () => {
    const ctx = new MockDshContext();
    const store = new PendingStore();
    const captured: CapturedRequest[] = [];
    const webhook = new WebhookClient({
      url: "http://127.0.0.1:8644/webhooks/dsh-events",
      secret: "wh-secret-123",
      logger: silentLogger,
      fetchImpl: makeCapturingFetch(captured),
    });

    const dispose = registerEventListeners(ctx, makeConfig(), store, webhook, silentLogger);
    try {
      const session: DshSession = {
        id: "sess_syncfuzz",
        header: { id: "sess_syncfuzz", cwd: "/home/user/workspace/syncfuzz" },
      };
      ctx.titles.set(session.id, "SyncFuzz 回归实验");
      const agent: DshAgent = { id: session.id, session, cancel: () => {} };

      // Record tool/call so argumentsPreview is populated
      ctx.emit("session/event", session, {
        seq: 1,
        time: 1000,
        type: "tool/call",
        data: {
          callId: "call_bash_1",
          name: "bash",
          arguments: JSON.stringify({ command: "rm -rf build/cache && pytest -n auto" }),
        },
      });

      // Downstream Web UI unavailable (browser closed) -> must wait for Hermes!
      const req1: DshApprovalRequestEvent = {
        agent,
        toolName: "bash",
        callId: "call_bash_1",
        reason: "Auto Review: destructive file removal",
      };

      const outcomePromise1 = ctx.waterfall<DshApprovalOutcome>(
        "approval/request",
        req1,
        () => Promise.resolve("unavailable"),
      );

      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 1);
      const evt1 = captured[0]!;
      assert.equal(evt1.payload.state, "paused_approval");
      assert.equal(evt1.payload.seqNo, 1);
      assert.equal(evt1.payload.shortId, "#1");
      assert.equal(evt1.payload.summary.startsWith("[#1] "), true);
      assert.equal(evt1.payload.taskTitle, "SyncFuzz 回归实验");
      assert.equal(
        evt1.payload.details["argumentsPreview"],
        "rm -rf build/cache && pytest -n auto",
      );
      const expectedSig = createHmac("sha256", "wh-secret-123")
        .update(`${evt1.headers["X-Webhook-Timestamp"]}.${evt1.rawBody}`, "utf8")
        .digest("hex");
      assert.equal(evt1.headers["X-Webhook-Signature-V2"], expectedSig);

      const pendingId1 = evt1.payload.pendingId!;
      assert.ok(pendingId1.startsWith("apr_"));
      const decideRes = store.decideApproval(pendingId1, "allowed-once");
      assert.equal(decideRes.ok, true);
      assert.equal(await outcomePromise1, "allowed-once");

      // AC-2: Web UI answers before Hermes -> late Hermes decision returns EXPIRED_OR_RESTARTED
      let resolveWebUi!: (v: DshApprovalOutcome) => void;
      const webUiHandler = (_req: DshApprovalRequestEvent) =>
        new Promise<DshApprovalOutcome>((resolve) => {
          resolveWebUi = resolve;
        });
      // Register Web UI downstream listener (append, not prepend)
      const removeWebUi = ctx.on("approval/request", webUiHandler);

      const outcomePromise2 = ctx.waterfall<DshApprovalOutcome>(
        "approval/request",
        { agent, toolName: "bash", callId: "call_bash_2" },
        () => Promise.resolve("unavailable"),
      );
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 2);
      const pendingId2 = captured[1]!.payload.pendingId!;

      // Web UI wins
      resolveWebUi("rejected");
      assert.equal(await outcomePromise2, "rejected");
      removeWebUi();

      const lateHermes = store.decideApproval(pendingId2, "allowed-once");
      assert.deepEqual(lateHermes, {
        ok: false,
        code: "EXPIRED_OR_RESTARTED",
        message: `Approval request "${pendingId2}" is no longer pending (already decided, timed out, or DSH restarted).`,
      });

      // allowed-session auto-approves subsequent asks in same session
      const outcomePromise3 = ctx.waterfall<DshApprovalOutcome>(
        "approval/request",
        { agent, toolName: "bash" },
        () => Promise.resolve("unavailable"),
      );
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 3);
      store.decideApproval(captured[2]!.payload.pendingId!, "allowed-session");
      assert.equal(await outcomePromise3, "allowed-once");

      const autoOutcome = await ctx.waterfall<DshApprovalOutcome>(
        "approval/request",
        { agent, toolName: "write_file" },
        () => Promise.resolve("unavailable"),
      );
      assert.equal(autoOutcome, "allowed-once");
      // No extra webhook fired when auto-approved
      assert.equal(captured.length, 3);
    } finally {
      dispose();
      store.dispose();
    }
  });

  it("AC-3: answers user-questions even when Web UI throws NO_PROVIDER and handles continued mode", async () => {
    const ctx = new MockDshContext();
    const store = new PendingStore();
    const captured: CapturedRequest[] = [];
    const webhook = new WebhookClient({
      url: "http://127.0.0.1:8644/webhooks/dsh-events",
      secret: "wh-secret-123",
      logger: silentLogger,
      fetchImpl: makeCapturingFetch(captured),
    });

    const dispose = registerEventListeners(ctx, makeConfig(), store, webhook, silentLogger);
    try {
      const session: DshSession = { id: "sess_q", header: { id: "sess_q", cwd: "/tmp/proj" } };
      const agent: DshAgent = { id: session.id, session, cancel: () => {} };

      const qReq: DshUserQuestionRequestEvent = {
        agent,
        questions: [
          {
            id: "q1",
            question: "Which test suite should run?",
            options: [{ label: "Unit" }, { label: "Integration" }],
          },
        ],
      };

      const noProviderErr = Object.assign(new Error("no answerer"), { code: "NO_PROVIDER" });
      const answerPromise = ctx.waterfall<AskUserQuestionAnswer>(
        "user-questions/request",
        qReq,
        () => Promise.reject(noProviderErr),
      );

      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 1);
      assert.equal(captured[0]!.payload.state, "paused_question");
      assert.equal(captured[0]!.payload.shortId, "#1");
      assert.equal(captured[0]!.payload.summary.startsWith("[#1] "), true);
      const qPendingId = captured[0]!.payload.pendingId!;
      assert.ok(qPendingId.startsWith("qst_"));

      const ansRes = store.answerQuestion("#1", { answerText: "Unit" });
      assert.equal(ansRes.ok, true);
      assert.deepEqual(await answerPromise, {
        answers: [{ id: "q1", selected: ["Unit"] }],
      });

      // Timed question transitioning to continued mode on ASK_TIMED_OUT
      const timedController = new AbortController();
      const timedReq: DshUserQuestionRequestEvent = {
        agent,
        signal: timedController.signal,
        wait: { callId: "call_q_timed", timed: true },
        questions: [{ id: "q2", question: "Proceed with deploy?" }],
      };

      const timedPromise = ctx.waterfall<AskUserQuestionAnswer>(
        "user-questions/request",
        timedReq,
        () => Promise.reject(noProviderErr),
      );
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 2);
      const q2PendingId = captured[1]!.payload.pendingId!;

      const timedOutErr = Object.assign(new Error("timed out"), { code: "ASK_TIMED_OUT" });
      timedController.abort(timedOutErr);
      await assert.rejects(timedPromise, (err: any) => err?.code === "ASK_TIMED_OUT");

      // Should still be answerable in continued mode!
      assert.equal(store.hasPendingQuestionForSession("sess_q"), true);
      const lateAns = store.answerQuestion(
        q2PendingId,
        { answerText: "继续部署" },
        ctx.userQuestions,
      );
      assert.equal(lateAns.ok, true);
      assert.equal(ctx.answeredContinued.length, 1);
      assert.equal(ctx.answeredContinued[0]?.callId, "call_q_timed");
      assert.deepEqual(ctx.answeredContinued[0]?.answer, {
        answers: [{ id: "q2", selected: [], custom: "继续部署" }],
      });
    } finally {
      dispose();
      store.dispose();
    }
  });

  it("AC-4 & AC-5: debounces 402/429 errors within errorDebounceMs and notifies only on long/non-trivial turn/end", async () => {
    const ctx = new MockDshContext();
    const store = new PendingStore();
    const captured: CapturedRequest[] = [];
    const webhook = new WebhookClient({
      url: "http://127.0.0.1:8644/webhooks/dsh-events",
      secret: "wh-secret-123",
      logger: silentLogger,
      fetchImpl: makeCapturingFetch(captured),
    });

    let fakeNow = 100_000;
    const dispose = registerEventListeners(
      ctx,
      makeConfig({ errorDebounceMs: 60_000, notifyOnTurnEndMinDurationMs: 10_000 }),
      store,
      webhook,
      silentLogger,
      () => fakeNow,
    );

    try {
      const session: DshSession = { id: "sess_err", header: { id: "sess_err", cwd: "/tmp/app" } };

      // 429 retry storm within 60s -> only 1 interrupted_error webhook
      ctx.emit("session/event", session, {
        seq: 1,
        time: fakeNow,
        type: "assistant/attempt",
        data: {
          turn: 1,
          step: 1,
          stream: [
            {
              type: "chunk",
              time: fakeNow,
              chunk: {
                type: "finish",
                reason: {
                  kind: "error",
                  failure: { code: "RATE_LIMIT", status: 429, message: "Too many requests" },
                },
              },
            },
          ],
        },
      });

      fakeNow += 10_000;
      ctx.emit("session/event", session, {
        seq: 2,
        time: fakeNow,
        type: "assistant/attempt",
        data: {
          turn: 1,
          step: 1,
          stream: [
            {
              type: "chunk",
              time: fakeNow,
              chunk: {
                type: "finish",
                reason: {
                  kind: "error",
                  failure: { code: "RATE_LIMIT", status: 429, message: "Still rate limited" },
                },
              },
            },
          ],
        },
      });

      // Even turn/end with the same 429 error within 60s is debounced
      ctx.emit("session/event", session, {
        seq: 3,
        time: fakeNow,
        type: "turn/end",
        data: {
          turn: 1,
          reason: {
            kind: "error",
            error: { code: "RATE_LIMIT", status: 429, message: "Rate limit failed" },
          },
        },
      });

      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 1);
      assert.equal(captured[0]!.payload.state, "interrupted_error");
      assert.equal(captured[0]!.payload.details["status"], 429);

      // Distinct error (402 quota) fires immediately
      ctx.emit("session/event", session, {
        seq: 4,
        time: fakeNow,
        type: "assistant/attempt",
        data: {
          turn: 2,
          step: 1,
          stream: [
            {
              type: "chunk",
              time: fakeNow,
              chunk: {
                type: "finish",
                reason: {
                  kind: "error",
                  failure: { code: "QUOTA", status: 402, message: "Insufficient balance" },
                },
              },
            },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 2);
      assert.equal(captured[1]!.payload.details["status"], 402);

      // Short completed turn (< 10_000ms) -> silent
      ctx.emit("session/event", session, { seq: 5, time: 200_000, type: "turn/start", data: { turn: 3 } });
      ctx.emit("session/event", session, {
        seq: 6,
        time: 202_000,
        type: "turn/end",
        data: { turn: 3, reason: { kind: "completed" } },
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 2);

      // Long completed turn (>= 10_000ms) -> sends stopped with truncated <= 500 char summary
      const longText = "A".repeat(600);
      ctx.emit("session/event", session, { seq: 7, time: 300_000, type: "turn/start", data: { turn: 4 } });
      ctx.emit("session/event", session, {
        seq: 8,
        time: 310_000,
        type: "assistant/message",
        data: {
          turn: 4,
          step: 1,
          message: { role: "assistant", content: [{ type: "text", text: longText }] },
        },
      });
      ctx.emit("session/event", session, {
        seq: 9,
        time: 315_000,
        type: "turn/end",
        data: { turn: 4, reason: { kind: "completed" } },
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(captured.length, 3);
      assert.equal(captured[2]!.payload.state, "stopped");
      assert.ok(captured[2]!.payload.summary.length <= 500);
      assert.equal(captured[2]!.payload.summary.endsWith("…"), true);
    } finally {
      dispose();
      store.dispose();
    }
  });

  it("aborts downstream Web UI signal when Hermes settles approval or question, while keeping original signal intact", async () => {
    const ctx = new MockDshContext();
    const store = new PendingStore();
    const captured: CapturedRequest[] = [];
    const webhook = new WebhookClient({
      url: "http://127.0.0.1:8644/webhooks/dsh-events",
      secret: "wh-secret-123",
      logger: silentLogger,
      fetchImpl: makeCapturingFetch(captured),
    });

    const dispose = registerEventListeners(ctx, makeConfig(), store, webhook, silentLogger);
    try {
      const session: DshSession = { id: "sess_dismiss", header: { id: "sess_dismiss", cwd: "/tmp/app" } };
      const agent: DshAgent = { id: session.id, session, cancel: () => {} };

      // 1. Approval with an active Turn AbortController: Hermes approval aborts downstream Web UI signal only
      const turnController = new AbortController();
      let observedApprovalSignal: AbortSignal | undefined;
      let downstreamCancelled = false;

      const removeWebApproval = ctx.on("approval/request", (req) => {
        observedApprovalSignal = req.signal;
        return new Promise<DshApprovalOutcome>((_resolve, reject) => {
          req.signal?.addEventListener(
            "abort",
            () => {
              downstreamCancelled = true;
              reject(new Error("remote event cancelled"));
            },
            { once: true },
          );
        });
      });

      const approvalReq: DshApprovalRequestEvent = {
        agent,
        toolName: "bash",
        signal: turnController.signal,
      };
      const approvalPromise = ctx.waterfall<DshApprovalOutcome>(
        "approval/request",
        approvalReq,
        () => Promise.resolve("unavailable"),
      );

      await new Promise((r) => setTimeout(r, 15));
      assert.ok(observedApprovalSignal);
      assert.notEqual(observedApprovalSignal, turnController.signal);
      assert.equal(observedApprovalSignal.aborted, false);

      const aprId = captured[0]!.payload.pendingId!;
      assert.equal(store.decideApproval(aprId, "allowed-once").ok, true);
      assert.equal(await approvalPromise, "allowed-once");
      await new Promise((r) => setTimeout(r, 5));

      assert.equal(observedApprovalSignal.aborted, true);
      assert.equal(downstreamCancelled, true);
      assert.equal(turnController.signal.aborted, false);
      assert.equal(approvalReq.signal, turnController.signal);
      removeWebApproval();

      // 2. Approval with no original signal: Web UI settles first -> downstream signal is NOT spuriously aborted
      let observedSecondSignal: AbortSignal | undefined;
      let resolveSecondWeb!: (outcome: DshApprovalOutcome) => void;
      const removeSecondWeb = ctx.on("approval/request", (req) => {
        observedSecondSignal = req.signal;
        return new Promise<DshApprovalOutcome>((resolve) => {
          resolveSecondWeb = resolve;
        });
      });

      const approvalReqNoSig: DshApprovalRequestEvent = { agent, toolName: "bash" };
      const approvalPromise2 = ctx.waterfall<DshApprovalOutcome>(
        "approval/request",
        approvalReqNoSig,
        () => Promise.resolve("unavailable"),
      );
      await new Promise((r) => setTimeout(r, 15));
      assert.ok(observedSecondSignal);
      assert.equal(observedSecondSignal.aborted, false);
      resolveSecondWeb("rejected");
      assert.equal(await approvalPromise2, "rejected");
      assert.equal(observedSecondSignal.aborted, false);
      assert.equal("signal" in approvalReqNoSig, false);
      removeSecondWeb();

      // 3. Question settled by Hermes aborts downstream Web UI signal without triggering ASK_ABORTED
      const qTurnController = new AbortController();
      let observedQuestionSignal: AbortSignal | undefined;
      let questionDownstreamCancelled = false;
      const removeWebQuestion = ctx.on("user-questions/request", (req) => {
        observedQuestionSignal = req.signal;
        return new Promise<AskUserQuestionAnswer>((_resolve, reject) => {
          req.signal?.addEventListener(
            "abort",
            () => {
              questionDownstreamCancelled = true;
              reject(new Error("remote question cancelled"));
            },
            { once: true },
          );
        });
      });

      const questionReq: DshUserQuestionRequestEvent = {
        agent,
        signal: qTurnController.signal,
        questions: [{ id: "q1", question: "Continue?" }],
      };
      const questionPromise = ctx.waterfall<AskUserQuestionAnswer>(
        "user-questions/request",
        questionReq,
        () => Promise.reject(new Error("NO_PROVIDER")),
      );

      await new Promise((r) => setTimeout(r, 15));
      assert.ok(observedQuestionSignal);
      assert.equal(observedQuestionSignal.aborted, false);

      const qstId = captured[2]!.payload.pendingId!;
      assert.equal(store.answerQuestion(qstId, { answerText: "是的" }).ok, true);
      assert.deepEqual(await questionPromise, {
        answers: [{ id: "q1", selected: [], custom: "是的" }],
      });
      await new Promise((r) => setTimeout(r, 5));

      assert.equal(observedQuestionSignal.aborted, true);
      assert.equal(questionDownstreamCancelled, true);
      assert.equal(qTurnController.signal.aborted, false);
      assert.equal(questionReq.signal, qTurnController.signal);
      removeWebQuestion();
    } finally {
      dispose();
      store.dispose();
    }
  });
});
