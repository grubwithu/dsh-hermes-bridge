import { basename } from "node:path";
import type {
  BridgeConfig,
  BridgeLogger,
  DshAgent,
  DshApprovalOutcome,
  DshContext,
  DshSession,
  DshSessionEvent,
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from "./types.js";
import type { PendingStore } from "./pending-store.js";
import type { WebhookClient } from "./webhook-client.js";

const MAX_TOOL_CALL_CACHE = 500;
const MAX_ARG_PREVIEW_CHARS = 300;
const MAX_SUMMARY_CHARS = 500;

export interface SessionCaches {
  titles: Map<string, string>;
  firstPrompts: Map<string, string>;
  turnStarts: Map<string, number>;
  lastAssistantTexts: Map<string, string>;
  toolCalls: Map<string, { name: string; arguments: string }>;
  errorLastSentAt: Map<string, number>;
}

export function createSessionCaches(): SessionCaches {
  return {
    titles: new Map(),
    firstPrompts: new Map(),
    turnStarts: new Map(),
    lastAssistantTexts: new Map(),
    toolCalls: new Map(),
    errorLastSentAt: new Map(),
  };
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text: string }).text;
      if (text.trim().length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
}

export function extractArgumentsPreview(toolName: string, rawArgs?: string): string {
  if (!rawArgs || rawArgs.trim().length === 0) {
    return "(无参数详情)";
  }
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if ((toolName === "bash" || toolName === "shell") && typeof parsed["command"] === "string") {
        return truncateText(parsed["command"].replace(/\s+/g, " "), MAX_ARG_PREVIEW_CHARS);
      }
      if (typeof parsed["cmd"] === "string") {
        return truncateText(parsed["cmd"].replace(/\s+/g, " "), MAX_ARG_PREVIEW_CHARS);
      }
      const pathCandidate = parsed["path"] ?? parsed["file_path"] ?? parsed["target_file"];
      if (typeof pathCandidate === "string") {
        return truncateText(`${pathCandidate} ${JSON.stringify(parsed)}`.replace(/\s+/g, " "), MAX_ARG_PREVIEW_CHARS);
      }
    }
    return truncateText(JSON.stringify(parsed), MAX_ARG_PREVIEW_CHARS);
  } catch {
    return truncateText(rawArgs.replace(/\s+/g, " "), MAX_ARG_PREVIEW_CHARS);
  }
}

export function resolveSessionMeta(
  ctx: DshContext,
  session: DshSession | undefined,
  caches: SessionCaches,
  fallbackSessionId = "unknown-session",
): { sessionId: string; taskTitle: string; cwd: string } {
  if (!session) {
    return {
      sessionId: fallbackSessionId,
      taskTitle: fallbackSessionId,
      cwd: "",
    };
  }
  const sessionId = session.id;
  const cwd = session.header?.cwd ?? "";

  let titleFromService: string | undefined;
  try {
    titleFromService = ctx.sessionTitle?.get(session)?.title;
  } catch {
    titleFromService = undefined;
  }

  const candidateTitle =
    titleFromService?.trim() ||
    caches.titles.get(sessionId)?.trim() ||
    caches.firstPrompts.get(sessionId)?.trim() ||
    (cwd ? basename(cwd) : "") ||
    sessionId;

  return {
    sessionId,
    taskTitle: candidateTitle,
    cwd,
  };
}

export interface ClassifiedFailure {
  category: string;
  code: string;
  status?: number;
  message: string;
  summary: string;
}

export function classifyLlmFailure(rawFailure: unknown): ClassifiedFailure | null {
  if (!rawFailure || typeof rawFailure !== "object") {
    const text = rawFailure === undefined || rawFailure === null ? "" : String(rawFailure);
    if (!text) return null;
    return {
      category: "unknown_error",
      code: "UNKNOWN",
      message: text,
      summary: `任务遇到异常中断：${truncateText(text, 240)}`,
    };
  }

  const obj = rawFailure as Record<string, unknown>;
  const code = typeof obj["code"] === "string" ? obj["code"] : "UNKNOWN";
  const status = typeof obj["status"] === "number" ? obj["status"] : undefined;
  const message =
    typeof obj["message"] === "string" && obj["message"].trim().length > 0
      ? obj["message"].trim()
      : code;

  if (code === "ABORTED") {
    return null;
  }

  if (status === 402 || code === "QUOTA" || code === "ACCOUNT_QUOTA") {
    return {
      category: "quota_402",
      code,
      ...(status !== undefined ? { status } : {}),
      message,
      summary: `API 余额不足或配额耗尽（${status ?? code}）：${truncateText(message, 220)}`,
    };
  }

  if (status === 429 || code === "RATE_LIMIT") {
    return {
      category: "rate_limit_429",
      code,
      ...(status !== undefined ? { status } : {}),
      message,
      summary: `触发 API 限流（${status ?? code}）：${truncateText(message, 220)}`,
    };
  }

  if (
    code === "AUTH" ||
    code === "INVALID_CREDENTIAL" ||
    code === "MISSING_CREDENTIAL" ||
    code === "ACCOUNT_SIGN_IN_REQUIRED" ||
    code === "ACCOUNT_TOKEN_INVALID" ||
    status === 401 ||
    status === 403
  ) {
    return {
      category: "auth_error",
      code,
      ...(status !== undefined ? { status } : {}),
      message,
      summary: `API 鉴权失败（${status ?? code}）：${truncateText(message, 220)}`,
    };
  }

  if (
    code === "STREAM_CLOSED" ||
    code === "TRANSPORT" ||
    code === "TIMEOUT" ||
    code === "MALFORMED_RESPONSE" ||
    code === "EMPTY_RESPONSE" ||
    code === "SERVER"
  ) {
    return {
      category: `stream_${code.toLowerCase()}`,
      code,
      ...(status !== undefined ? { status } : {}),
      message,
      summary: `模型连接或流式输出异常（${code}${status ? ` / HTTP ${status}` : ""}）：${truncateText(message, 220)}`,
    };
  }

  return {
    category: `error_${code.toLowerCase()}_${status ?? "none"}`,
    code,
    ...(status !== undefined ? { status } : {}),
    message,
    summary: `任务异常中断（${code}${status ? ` / HTTP ${status}` : ""}）：${truncateText(message, 220)}`,
  };
}

function extractFailureFromAttemptStream(stream: unknown): unknown {
  if (!Array.isArray(stream)) {
    return null;
  }
  for (let i = stream.length - 1; i >= 0; i--) {
    const rec = stream[i] as Record<string, unknown> | undefined;
    if (!rec || rec["type"] !== "chunk") continue;
    const chunk = rec["chunk"] as Record<string, unknown> | undefined;
    if (!chunk) continue;
    if (chunk["type"] === "finish") {
      const reason = chunk["reason"] as Record<string, unknown> | undefined;
      if (reason && (reason["kind"] === "error" || reason["kind"] === "aborted") && reason["failure"]) {
        if (reason["kind"] === "error") {
          return reason["failure"];
        }
      }
    }
    if (chunk["type"] === "error") {
      return chunk["failure"] ?? chunk["error"] ?? chunk;
    }
  }
  return null;
}

function formatQuestionsSummary(questions: AskUserQuestionItem[]): string {
  if (questions.length === 0) {
    return "DSH Agent 向你提出了一个问题。";
  }
  if (questions.length === 1) {
    const q = questions[0]!;
    const optLabels = (q.options ?? []).map((o) => o.label);
    const optSuffix = optLabels.length > 0 ? `（可选项：${optLabels.join(" / ")}）` : "";
    return truncateText(`${q.question}${optSuffix}`, 360);
  }
  const joined = questions.map((q, idx) => `${idx + 1}. ${q.question}`).join("；");
  return truncateText(`DSH Agent 提出了 ${questions.length} 个问题：${joined}`, 360);
}

function makeAbortError(signal: AbortSignal, fallbackMessage: string): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const err = new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : fallbackMessage,
  );
  err.name = "AbortError";
  return err;
}

function setBoundedCache<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function registerEventListeners(
  ctx: DshContext,
  config: BridgeConfig,
  store: PendingStore,
  webhook: WebhookClient,
  logger: BridgeLogger,
  nowFn: () => number = Date.now,
): () => void {
  const caches = createSessionCaches();
  const disposers: Array<() => unknown> = [];

  const emitDebouncedError = (
    session: DshSession | undefined,
    rawFailure: unknown,
    extra: Record<string, unknown> = {},
  ): void => {
    const classified = classifyLlmFailure(rawFailure);
    if (!classified) {
      return;
    }
    const meta = resolveSessionMeta(ctx, session, caches);
    const debounceKey = `${meta.sessionId}:${classified.category}`;
    const now = nowFn();
    const prevAt = caches.errorLastSentAt.get(debounceKey);
    if (prevAt !== undefined && now - prevAt < config.errorDebounceMs) {
      return;
    }
    caches.errorLastSentAt.set(debounceKey, now);

    void webhook.send({
      sessionId: meta.sessionId,
      taskTitle: meta.taskTitle,
      cwd: meta.cwd,
      state: "interrupted_error",
      stateLabel: "异常中断",
      summary: classified.summary,
      details: {
        code: classified.code,
        ...(classified.status !== undefined ? { status: classified.status } : {}),
        message: classified.message,
        ...extra,
      },
    });
  };

  // 1. Approval waterfall listener (prepend: true so we race alongside Web UI forwarder)
  disposers.push(
    ctx.on(
      "approval/request",
      async (req, next): Promise<DshApprovalOutcome> => {
        if (req.signal?.aborted) {
          return "cancelled";
        }

        const session = req.agent?.session;
        const meta = resolveSessionMeta(ctx, session, caches, req.agent?.id ?? "unknown-session");

        if (store.isSessionAutoApproved(meta.sessionId)) {
          return "allowed-once";
        }

        const cachedCall = req.callId ? caches.toolCalls.get(req.callId) : undefined;
        const argumentsPreview = extractArgumentsPreview(
          req.toolName,
          cachedCall?.arguments,
        );
        const reasonText =
          req.reason ?? req.displayReason?.["zh"] ?? req.displayReason?.en;

        const { pendingId, promise: hermesPromise, expiresAt } = store.addApproval({
          sessionId: meta.sessionId,
          taskTitle: meta.taskTitle,
          cwd: meta.cwd,
          toolName: req.toolName,
          callId: req.callId,
          argumentsPreview,
          reason: reasonText,
          timeoutMs: config.approvalTimeoutMs,
          onTimeout: (timedOutId) => {
            logger.warn(
              `[dsh-hermes-bridge] Approval ${timedOutId} (${req.toolName}) timed out after ${config.approvalTimeoutMs}ms -> rejected`,
            );
          },
        });

        const summary = `需要人工审批 ${req.toolName} 调用：${argumentsPreview}${reasonText ? `（原因：${reasonText}）` : ""}`;
        void webhook.send({
          sessionId: meta.sessionId,
          taskTitle: meta.taskTitle,
          cwd: meta.cwd,
          state: "paused_approval",
          stateLabel: "等待 Tool Call 授权",
          pendingId,
          summary: truncateText(summary, MAX_SUMMARY_CHARS),
          details: {
            toolName: req.toolName,
            argumentsPreview,
            ...(req.callId !== undefined ? { callId: req.callId } : {}),
            ...(reasonText !== undefined ? { reason: reasonText } : {}),
            expiresAt,
          },
        });

        // Wrap next() so that 'unavailable' (e.g. no browser client attached) does NOT
        // short-circuit the race before Hermes can respond.
        const nextWinner = new Promise<DshApprovalOutcome>((resolve) => {
          Promise.resolve()
            .then(() => next())
            .then(
              (outcome) => {
                if (outcome === "allowed-once" || outcome === "rejected" || outcome === "cancelled") {
                  resolve(outcome);
                }
              },
              () => {
                // Downstream threw: ignore and keep waiting for Hermes / abort / timeout
              },
            );
        });

        let onAbort: (() => void) | undefined;
        const signalWinner = new Promise<DshApprovalOutcome>((resolve) => {
          if (!req.signal) return;
          if (req.signal.aborted) {
            resolve("cancelled");
            return;
          }
          onAbort = () => resolve("cancelled");
          req.signal.addEventListener("abort", onAbort, { once: true });
        });

        try {
          const result = await Promise.race([
            hermesPromise.then((outcome) => ({ source: "hermes" as const, outcome })),
            nextWinner.then((outcome) => ({ source: "next" as const, outcome })),
            signalWinner.then((outcome) => ({ source: "signal" as const, outcome })),
          ]);

          if (result.source !== "hermes") {
            store.settleApprovalExternally(pendingId, result.outcome);
          }

          return result.outcome;
        } finally {
          if (onAbort && req.signal) {
            req.signal.removeEventListener("abort", onAbort);
          }
        }
      },
      { prepend: true },
    ),
  );

  // 2. User-questions waterfall listener (prepend: true so headless/Telegram works even without Web UI)
  disposers.push(
    ctx.on(
      "user-questions/request",
      async (request, next): Promise<AskUserQuestionAnswer> => {
        if (request.signal?.aborted) {
          throw makeAbortError(request.signal, "ask_user_question was aborted before the user answered");
        }

        const agent: DshAgent | undefined = request.agent;
        const meta = resolveSessionMeta(
          ctx,
          agent?.session,
          caches,
          agent?.id ?? "unknown-session",
        );

        const { pendingId, promise: hermesPromise, expiresAt } = store.addQuestion({
          sessionId: meta.sessionId,
          taskTitle: meta.taskTitle,
          cwd: meta.cwd,
          questions: request.questions,
          callId: request.wait?.callId,
          timeoutMs: config.questionTimeoutMs,
          onTimeout: (timedOutId) => {
            logger.warn(
              `[dsh-hermes-bridge] Question ${timedOutId} timed out after ${config.questionTimeoutMs}ms`,
            );
          },
        });
        // Prevent unhandled rejection warnings if next() or signal settles first
        hermesPromise.catch(() => {});

        void webhook.send({
          sessionId: meta.sessionId,
          taskTitle: meta.taskTitle,
          cwd: meta.cwd,
          state: "paused_question",
          stateLabel: "等待回答提问",
          pendingId,
          summary: formatQuestionsSummary(request.questions),
          details: {
            questions: request.questions,
            ...(request.wait?.callId !== undefined ? { callId: request.wait.callId } : {}),
            timed: request.wait?.timed ?? false,
            expiresAt,
          },
        });

        // Downstream next(): only resolve if a UI answerer returns an actual answer.
        // Rejections like NO_PROVIDER (when no browser tab is open) must NOT abort Hermes!
        const nextWinner = new Promise<{ source: "next"; answer: AskUserQuestionAnswer }>((resolve) => {
          Promise.resolve()
            .then(() => next())
            .then(
              (answer) => {
                if (answer && Array.isArray(answer.answers)) {
                  resolve({ source: "next", answer });
                }
              },
              () => {
                // Ignore NO_PROVIDER or downstream absence so Hermes can answer
              },
            );
        });

        let onAbort: (() => void) | undefined;
        const signalWinner = new Promise<{ source: "signal"; reason: unknown }>((resolve) => {
          const signal = request.signal;
          if (!signal) return;
          if (signal.aborted) {
            resolve({ source: "signal", reason: signal.reason });
            return;
          }
          onAbort = () => resolve({ source: "signal", reason: signal.reason });
          signal.addEventListener("abort", onAbort, { once: true });
        });

        try {
          const winner = await Promise.race([
            hermesPromise.then((answer) => ({ source: "hermes" as const, answer })),
            nextWinner,
            signalWinner,
          ]);

          if (winner.source === "hermes") {
            return winner.answer;
          }

          if (winner.source === "next") {
            store.settleQuestionExternally(pendingId, new Error("Answered by another surface"));
            return winner.answer;
          }

          const reason = winner.reason;
          const reasonCode =
            typeof reason === "object" && reason !== null
              ? (reason as { code?: unknown }).code
              : undefined;

          if (reasonCode === "ASK_TIMED_OUT" && agent && request.wait?.callId) {
            store.markQuestionContinued(pendingId, agent, request.wait.callId);
          } else {
            const abortErr =
              reason instanceof Error
                ? reason
                : makeAbortError(request.signal!, "ask_user_question aborted");
            store.settleQuestionExternally(pendingId, abortErr);
          }

          throw reason instanceof Error
            ? reason
            : makeAbortError(request.signal!, "ask_user_question aborted");
        } finally {
          if (onAbort && request.signal) {
            request.signal.removeEventListener("abort", onAbort);
          }
        }
      },
      { prepend: true },
    ),
  );

  // 3. Session event listener (tool calls, title, prompts, assistant output, attempt errors, turn/end)
  disposers.push(
    ctx.on(
      "session/event",
      (session: DshSession, event: DshSessionEvent) => {
        if (!session || !event) return;
        const data = event.data ?? {};

        switch (event.type) {
          case "tool/call": {
            const callId = typeof data["callId"] === "string" ? data["callId"] : "";
            const toolName = typeof data["name"] === "string" ? data["name"] : "";
            const rawArgs = typeof data["arguments"] === "string" ? data["arguments"] : "";
            if (callId) {
              setBoundedCache(caches.toolCalls, callId, { name: toolName, arguments: rawArgs }, MAX_TOOL_CALL_CACHE);
            }
            break;
          }
          case "session/title": {
            const title = typeof data["title"] === "string" ? data["title"].trim() : "";
            if (title) {
              caches.titles.set(session.id, title);
            }
            break;
          }
          case "user/message": {
            if (!caches.firstPrompts.has(session.id)) {
              const source = data["source"] as { kind?: unknown } | undefined;
              if (!source || source.kind === "user") {
                const text = extractTextFromContent(data["content"]);
                if (text) {
                  caches.firstPrompts.set(session.id, truncateText(text.replace(/\s+/g, " "), 40));
                }
              }
            }
            break;
          }
          case "turn/start": {
            caches.turnStarts.set(session.id, typeof event.time === "number" ? event.time : nowFn());
            break;
          }
          case "assistant/message": {
            const msg = data["message"] as { content?: unknown } | undefined;
            const text = extractTextFromContent(msg?.content);
            if (text) {
              caches.lastAssistantTexts.set(session.id, text);
            }
            break;
          }
          case "assistant/attempt": {
            const failure = extractFailureFromAttemptStream(data["stream"]);
            if (failure) {
              emitDebouncedError(session, failure, {
                turn: data["turn"],
                step: data["step"],
                source: "assistant/attempt",
              });
            }
            break;
          }
          case "turn/end": {
            const reason = (data["reason"] ?? {}) as {
              kind?: string;
              error?: unknown;
              reason?: { kind?: string; reason?: string };
            };
            const endTime = typeof event.time === "number" ? event.time : nowFn();
            const startTime = caches.turnStarts.get(session.id);
            const durationMs = startTime !== undefined ? Math.max(0, endTime - startTime) : 0;
            caches.turnStarts.delete(session.id);

            const meta = resolveSessionMeta(ctx, session, caches);
            const reasonKind = reason.kind ?? "unknown";

            if (reasonKind === "error") {
              emitDebouncedError(session, reason.error, {
                turn: data["turn"],
                durationMs,
                source: "turn/end",
              });
              const errMsg =
                typeof (reason.error as { message?: unknown } | undefined)?.message === "string"
                  ? String((reason.error as { message: string }).message)
                  : "Turn failed with error";
              store.recordStopped({
                sessionId: meta.sessionId,
                taskTitle: meta.taskTitle,
                cwd: meta.cwd,
                reasonKind: "error",
                durationMs,
                summary: truncateText(errMsg, MAX_SUMMARY_CHARS),
                stoppedAt: new Date(endTime).toISOString(),
              });
              break;
            }

            const lastText = caches.lastAssistantTexts.get(session.id) ?? "";
            const fallbackSummary =
              reasonKind === "completed"
                ? "任务执行已完成。"
                : reasonKind === "aborted"
                  ? "任务已被中止。"
                  : reasonKind === "max-tokens"
                    ? "输出达到最大长度上限并停止。"
                    : `任务已停止（原因：${reasonKind}）。`;
            const summary = truncateText(lastText || fallbackSummary, MAX_SUMMARY_CHARS);

            store.recordStopped({
              sessionId: meta.sessionId,
              taskTitle: meta.taskTitle,
              cwd: meta.cwd,
              reasonKind,
              durationMs,
              summary,
              stoppedAt: new Date(endTime).toISOString(),
            });

            if (reasonKind === "completed" && durationMs < config.notifyOnTurnEndMinDurationMs) {
              break;
            }
            if (reasonKind === "aborted" && reason.reason?.kind === "disposed") {
              break;
            }

            const stateLabel =
              reasonKind === "completed"
                ? "任务已完成"
                : reasonKind === "aborted"
                  ? "任务已中止"
                  : "任务已停止";

            void webhook.send({
              sessionId: meta.sessionId,
              taskTitle: meta.taskTitle,
              cwd: meta.cwd,
              state: "stopped",
              stateLabel,
              summary,
              details: {
                turn: data["turn"],
                reasonKind,
                ...(reason.reason ? { cancelCause: reason.reason } : {}),
                durationMs,
              },
            });
            break;
          }
        }
      },
      { global: true },
    ),
  );

  // 4. Agent-level error & lifecycle cleanup listeners
  disposers.push(
    ctx.on(
      "agent/error",
      (payload: { agent?: DshAgent; turn?: number; step?: number; error?: unknown }) => {
        if (!payload?.error) return;
        const errObj = payload.error as { code?: unknown; name?: unknown; failure?: unknown };
        if (errObj.code === "ABORTED" || errObj.name === "AbortError") {
          return;
        }
        emitDebouncedError(payload.agent?.session, errObj.failure ?? payload.error, {
          turn: payload.turn,
          step: payload.step,
          source: "agent/error",
        });
      },
      { global: true },
    ),
  );

  const cleanupSession = (sessionId: string | undefined) => {
    if (!sessionId) return;
    store.clearSession(sessionId);
    caches.titles.delete(sessionId);
    caches.firstPrompts.delete(sessionId);
    caches.turnStarts.delete(sessionId);
    caches.lastAssistantTexts.delete(sessionId);
  };

  disposers.push(
    ctx.on(
      "session/disposed",
      (session: DshSession) => {
        cleanupSession(session?.id);
      },
      { global: true },
    ),
  );

  disposers.push(
    ctx.on(
      "agent/disposed",
      (payload: { agent?: DshAgent }) => {
        cleanupSession(payload?.agent?.session?.id ?? payload?.agent?.id);
      },
      { global: true },
    ),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore listener cleanup errors
      }
    }
  };
}
