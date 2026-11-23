import { randomBytes } from "node:crypto";
import type {
  ApprovalDecision,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  DshAgent,
  DshApprovalOutcome,
  DshUserQuestionsService,
  PendingApprovalView,
  PendingQuestionView,
  RecentStoppedView,
} from "./types.js";

const MAX_RECENT_STOPPED = 20;

export interface AddApprovalInput {
  sessionId: string;
  taskTitle: string;
  cwd: string;
  toolName: string;
  callId?: string;
  argumentsPreview: string;
  reason?: string;
  timeoutMs: number;
  onTimeout?: (pendingId: string, entry: PendingApprovalView) => void;
}

export interface AddQuestionInput {
  sessionId: string;
  taskTitle: string;
  cwd: string;
  questions: AskUserQuestionItem[];
  callId?: string;
  timeoutMs: number;
  onTimeout?: (pendingId: string, entry: PendingQuestionView) => void;
}

interface PendingApprovalEntry {
  pendingId: string;
  seqNo: number;
  shortId: string;
  sessionId: string;
  taskTitle: string;
  cwd: string;
  toolName: string;
  callId?: string;
  argumentsPreview: string;
  reason?: string;
  createdAt: string;
  expiresAt: string;
  settled: boolean;
  resolve: (outcome: DshApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestionEntry {
  pendingId: string;
  seqNo: number;
  shortId: string;
  sessionId: string;
  taskTitle: string;
  cwd: string;
  questions: AskUserQuestionItem[];
  callId?: string;
  mode: "open" | "continued";
  agent?: DshAgent;
  createdAt: string;
  expiresAt: string;
  settled: boolean;
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type DecideApprovalResult =
  | {
      ok: true;
      pendingId: string;
      seqNo: number;
      shortId: string;
      sessionId: string;
      decision: ApprovalDecision;
      dshOutcome: "allowed-once" | "rejected";
    }
  | {
      ok: false;
      code: "EXPIRED_OR_RESTARTED";
      message: string;
    };

export type AnswerQuestionResult =
  | {
      ok: true;
      pendingId: string;
      seqNo: number;
      shortId: string;
      sessionId: string;
      mode: "open" | "continued";
      answer: AskUserQuestionAnswer;
    }
  | {
      ok: false;
      code: "EXPIRED_OR_RESTARTED" | "USER_QUESTIONS_UNAVAILABLE" | "REPLY_ERROR";
      message: string;
    };

export function createQuestionTimeoutError(pendingId: string): Error & { code: string } {
  const err = new Error(`Pending question ${pendingId} timed out waiting for user response`) as Error & {
    code: string;
  };
  err.name = "QuestionTimeoutError";
  err.code = "QUESTION_TIMED_OUT";
  return err;
}

function generateShortId(prefix: string, existing: Map<string, unknown>): string {
  for (let bytes = 2; bytes <= 4; bytes++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = `${prefix}_${randomBytes(bytes).toString("hex")}`;
      if (!existing.has(candidate)) {
        return candidate;
      }
    }
  }
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function formatQuestionText(questions: AskUserQuestionItem[]): string {
  return questions
    .map((q, index) => {
      const prefix = questions.length > 1 ? `${index + 1}. ` : "";
      return `${prefix}${q.question}`;
    })
    .join("\n");
}

function flattenQuestionOptions(questions: AskUserQuestionItem[]): Array<{ label: string; description?: string }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; description?: string }> = [];
  for (const q of questions) {
    for (const opt of q.options ?? []) {
      if (!seen.has(opt.label)) {
        seen.add(opt.label);
        out.push(opt.description ? { label: opt.label, description: opt.description } : { label: opt.label });
      }
    }
  }
  return out;
}

function matchApprovalIntent(
  q: AskUserQuestionItem,
  answerText: string,
): string | undefined {
  if (q.intent?.kind === "approval") {
    const normalized = answerText.trim().toLowerCase();
    if (q.intent.always && /^(总是|以后都|始终|always|allow[- ]?always|always[- ]?allow)$/i.test(normalized)) {
      return q.intent.always;
    }
    if (/^(同意|允许|放行|批准|通过|确认|好的?|可以|行|是|yes|ok|okay|approve|allow)$/i.test(normalized)) {
      return q.intent.approve;
    }
    if (/^(拒绝|不同意|取消|不行|不要|否|不|no|reject|deny|decline|cancel)$/i.test(normalized)) {
      return q.intent.reject;
    }
  }
  if (q.intent?.kind === "plan-review") {
    const normalized = answerText.trim().toLowerCase();
    if (/^(同意|批准|通过|确认|按这个做|可以|yes|approve|ok)$/i.test(normalized)) {
      return q.intent.approve;
    }
  }
  return undefined;
}

export function buildAskUserQuestionAnswer(
  questions: AskUserQuestionItem[],
  answerText: string,
  selectedOptions?: string[],
): AskUserQuestionAnswer {
  const trimmedText = answerText.trim();
  const normalizedSelectedInput = (selectedOptions ?? []).map((item) => item.trim()).filter(Boolean);

  const answers: AskUserQuestionAnswerItem[] = questions.map((q) => {
    const options = q.options ?? [];
    const matchedLabels: string[] = [];

    if (normalizedSelectedInput.length > 0 && options.length > 0) {
      for (const candidate of normalizedSelectedInput) {
        const found = options.find(
          (opt) => opt.label === candidate || opt.label.toLowerCase() === candidate.toLowerCase(),
        );
        if (found && !matchedLabels.includes(found.label)) {
          matchedLabels.push(found.label);
        }
      }
    }

    if (matchedLabels.length === 0 && options.length > 0 && trimmedText.length > 0) {
      const exact = options.find(
        (opt) => opt.label === trimmedText || opt.label.toLowerCase() === trimmedText.toLowerCase(),
      );
      if (exact) {
        matchedLabels.push(exact.label);
      } else if (q.multiSelect) {
        const parts = trimmedText
          .split(/[,，、\n]+/)
          .map((part) => part.trim())
          .filter(Boolean);
        for (const part of parts) {
          const found = options.find(
            (opt) => opt.label === part || opt.label.toLowerCase() === part.toLowerCase(),
          );
          if (found && !matchedLabels.includes(found.label)) {
            matchedLabels.push(found.label);
          }
        }
      }
    }

    if (matchedLabels.length === 0 && trimmedText.length > 0) {
      const intentLabel = matchApprovalIntent(q, trimmedText);
      if (intentLabel) {
        matchedLabels.push(intentLabel);
      }
    }

    if (matchedLabels.length > 0) {
      const finalSelected = q.multiSelect ? matchedLabels : [matchedLabels[0]!];
      const matchesExactOptionOnly =
        finalSelected.length === 1 &&
        finalSelected[0]!.toLowerCase() === trimmedText.toLowerCase();
      if (q.multiSelect && trimmedText.length > 0 && !matchesExactOptionOnly && normalizedSelectedInput.length > 0) {
        return {
          id: q.id,
          selected: finalSelected,
          custom: trimmedText,
        };
      }
      return {
        id: q.id,
        selected: finalSelected,
      };
    }

    return {
      id: q.id,
      selected: [],
      custom: trimmedText || answerText,
    };
  });

  return { answers };
}

function parseShortSeqRef(ref: string): number | undefined {
  const match = /^(?:#|no\.?\s*|编号\s*|apr_|qst_)?0*([1-9]\d*)$/i.exec(ref.trim());
  if (!match?.[1]) {
    return undefined;
  }
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export class PendingStore {
  private readonly approvals = new Map<string, PendingApprovalEntry>();
  private readonly questions = new Map<string, PendingQuestionEntry>();
  private readonly sessionAutoApproved = new Set<string>();
  private readonly recentStopped: RecentStoppedView[] = [];
  private seqCounter = 0;
  private disposed = false;

  nextShortId(): { seqNo: number; shortId: string } {
    this.seqCounter += 1;
    return {
      seqNo: this.seqCounter,
      shortId: `#${this.seqCounter}`,
    };
  }

  private findApprovalEntry(ref: string): PendingApprovalEntry | undefined {
    const trimmed = ref.trim();
    const direct = this.approvals.get(trimmed);
    if (direct && !direct.settled) {
      return direct;
    }
    const seqNo = parseShortSeqRef(trimmed);
    if (seqNo !== undefined) {
      for (const entry of this.approvals.values()) {
        if (!entry.settled && entry.seqNo === seqNo) {
          return entry;
        }
      }
    }
    return undefined;
  }

  private findQuestionEntry(ref: string): PendingQuestionEntry | undefined {
    const trimmed = ref.trim();
    const direct = this.questions.get(trimmed);
    if (direct && !direct.settled) {
      return direct;
    }
    const seqNo = parseShortSeqRef(trimmed);
    if (seqNo !== undefined) {
      for (const entry of this.questions.values()) {
        if (!entry.settled && entry.seqNo === seqNo) {
          return entry;
        }
      }
    }
    return undefined;
  }

  addApproval(input: AddApprovalInput): {
    pendingId: string;
    seqNo: number;
    shortId: string;
    promise: Promise<DshApprovalOutcome>;
    expiresAt: string;
    view: PendingApprovalView;
  } {
    if (this.disposed) {
      return {
        pendingId: "apr_disposed",
        seqNo: 0,
        shortId: "#0",
        promise: Promise.resolve("rejected"),
        expiresAt: new Date().toISOString(),
        view: {
          pendingId: "apr_disposed",
          seqNo: 0,
          shortId: "#0",
          sessionId: input.sessionId,
          taskTitle: input.taskTitle,
          cwd: input.cwd,
          toolName: input.toolName,
          callId: input.callId,
          argumentsPreview: input.argumentsPreview,
          reason: input.reason,
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        },
      };
    }

    const pendingId = generateShortId("apr", this.approvals);
    const { seqNo, shortId } = this.nextShortId();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + input.timeoutMs).toISOString();

    let resolvePromise!: (outcome: DshApprovalOutcome) => void;
    const promise = new Promise<DshApprovalOutcome>((resolve) => {
      resolvePromise = resolve;
    });

    const timer = setTimeout(() => {
      const current = this.approvals.get(pendingId);
      if (!current || current.settled) {
        return;
      }
      current.settled = true;
      this.approvals.delete(pendingId);
      const view = this.toApprovalView(current);
      current.resolve("rejected");
      input.onTimeout?.(pendingId, view);
    }, Math.max(1, input.timeoutMs));
    timer.unref?.();

    const entry: PendingApprovalEntry = {
      pendingId,
      seqNo,
      shortId,
      sessionId: input.sessionId,
      taskTitle: input.taskTitle,
      cwd: input.cwd,
      toolName: input.toolName,
      callId: input.callId,
      argumentsPreview: input.argumentsPreview,
      reason: input.reason,
      createdAt,
      expiresAt,
      settled: false,
      resolve: resolvePromise,
      timer,
    };

    this.approvals.set(pendingId, entry);
    return {
      pendingId,
      seqNo,
      shortId,
      promise,
      expiresAt,
      view: this.toApprovalView(entry),
    };
  }

  decideApproval(pendingId: string, decision: ApprovalDecision): DecideApprovalResult {
    const entry = this.findApprovalEntry(pendingId);
    if (!entry || entry.settled) {
      return {
        ok: false,
        code: "EXPIRED_OR_RESTARTED",
        message: `Approval request "${pendingId}" is no longer pending (already decided, timed out, or DSH restarted).`,
      };
    }

    entry.settled = true;
    clearTimeout(entry.timer);
    this.approvals.delete(entry.pendingId);

    if (decision === "allowed-session") {
      this.sessionAutoApproved.add(entry.sessionId);
    }

    const dshOutcome: "allowed-once" | "rejected" =
      decision === "rejected" ? "rejected" : "allowed-once";
    entry.resolve(dshOutcome);

    return {
      ok: true,
      pendingId: entry.pendingId,
      seqNo: entry.seqNo,
      shortId: entry.shortId,
      sessionId: entry.sessionId,
      decision,
      dshOutcome,
    };
  }

  settleApprovalExternally(pendingId: string, outcome: DshApprovalOutcome = "cancelled"): boolean {
    const entry = this.findApprovalEntry(pendingId);
    if (!entry || entry.settled) {
      return false;
    }
    entry.settled = true;
    clearTimeout(entry.timer);
    this.approvals.delete(entry.pendingId);
    entry.resolve(outcome);
    return true;
  }

  isSessionAutoApproved(sessionId: string): boolean {
    return this.sessionAutoApproved.has(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessionAutoApproved.delete(sessionId);
    for (const [id, entry] of this.approvals.entries()) {
      if (entry.sessionId === sessionId) {
        this.settleApprovalExternally(id, "cancelled");
      }
    }
    for (const [id, entry] of this.questions.entries()) {
      if (entry.sessionId === sessionId) {
        this.settleQuestionExternally(id, new Error(`Session ${sessionId} disposed`));
      }
    }
  }

  addQuestion(input: AddQuestionInput): {
    pendingId: string;
    seqNo: number;
    shortId: string;
    promise: Promise<AskUserQuestionAnswer>;
    expiresAt: string;
    view: PendingQuestionView;
  } {
    if (this.disposed) {
      const err = new Error("PendingStore disposed");
      const rejected = Promise.reject(err);
      rejected.catch(() => {});
      return {
        pendingId: "qst_disposed",
        seqNo: 0,
        shortId: "#0",
        promise: rejected,
        expiresAt: new Date().toISOString(),
        view: {
          pendingId: "qst_disposed",
          seqNo: 0,
          shortId: "#0",
          sessionId: input.sessionId,
          taskTitle: input.taskTitle,
          cwd: input.cwd,
          callId: input.callId,
          mode: "open",
          questions: input.questions,
          questionText: formatQuestionText(input.questions),
          options: flattenQuestionOptions(input.questions),
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        },
      };
    }

    const pendingId = generateShortId("qst", this.questions);
    const { seqNo, shortId } = this.nextShortId();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + input.timeoutMs).toISOString();

    let resolvePromise!: (answer: AskUserQuestionAnswer) => void;
    let rejectPromise!: (err: Error) => void;
    const promise = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const timer = setTimeout(() => {
      const current = this.questions.get(pendingId);
      if (!current || current.settled) {
        return;
      }
      current.settled = true;
      this.questions.delete(pendingId);
      const view = this.toQuestionView(current);
      if (current.mode === "open") {
        current.reject(createQuestionTimeoutError(pendingId));
      }
      input.onTimeout?.(pendingId, view);
    }, Math.max(1, input.timeoutMs));
    timer.unref?.();

    const entry: PendingQuestionEntry = {
      pendingId,
      seqNo,
      shortId,
      sessionId: input.sessionId,
      taskTitle: input.taskTitle,
      cwd: input.cwd,
      questions: input.questions,
      callId: input.callId,
      mode: "open",
      createdAt,
      expiresAt,
      settled: false,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    };

    this.questions.set(pendingId, entry);
    return {
      pendingId,
      seqNo,
      shortId,
      promise,
      expiresAt,
      view: this.toQuestionView(entry),
    };
  }

  markQuestionContinued(pendingId: string, agent: DshAgent, callId: string): boolean {
    const entry = this.findQuestionEntry(pendingId);
    if (!entry || entry.settled) {
      return false;
    }
    entry.mode = "continued";
    entry.agent = agent;
    entry.callId = callId;
    return true;
  }

  answerQuestion(
    pendingId: string,
    input: { answerText: string; selectedOptions?: string[] },
    userQuestionsProvider?:
      | DshUserQuestionsService
      | (() => DshUserQuestionsService | undefined),
  ): AnswerQuestionResult {
    const entry = this.findQuestionEntry(pendingId);
    if (!entry || entry.settled) {
      return {
        ok: false,
        code: "EXPIRED_OR_RESTARTED",
        message: `Question "${pendingId}" is no longer pending (already answered, timed out, cancelled, or DSH restarted).`,
      };
    }

    const answer = buildAskUserQuestionAnswer(
      entry.questions,
      input.answerText,
      input.selectedOptions,
    );

    if (entry.mode === "continued") {
      const userQuestionsService =
        typeof userQuestionsProvider === "function"
          ? userQuestionsProvider()
          : userQuestionsProvider;

      if (!userQuestionsService || !entry.agent || !entry.callId) {
        return {
          ok: false,
          code: "USER_QUESTIONS_UNAVAILABLE",
          message: `Question "${entry.pendingId}" (${entry.shortId}) transitioned to continued mode, but ctx.userQuestions or agent handle is unavailable.`,
        };
      }

      try {
        const accepted = userQuestionsService.answer(entry.agent, entry.callId, answer);
        entry.settled = true;
        clearTimeout(entry.timer);
        this.questions.delete(entry.pendingId);
        if (!accepted) {
          return {
            ok: false,
            code: "EXPIRED_OR_RESTARTED",
            message: `Continued question "${entry.pendingId}" (${entry.shortId}) was already answered or cancelled on DSH.`,
          };
        }
        return {
          ok: true,
          pendingId: entry.pendingId,
          seqNo: entry.seqNo,
          shortId: entry.shortId,
          sessionId: entry.sessionId,
          mode: "continued",
          answer,
        };
      } catch (err) {
        return {
          ok: false,
          code: "REPLY_ERROR",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    entry.settled = true;
    clearTimeout(entry.timer);
    this.questions.delete(entry.pendingId);
    entry.resolve(answer);

    return {
      ok: true,
      pendingId: entry.pendingId,
      seqNo: entry.seqNo,
      shortId: entry.shortId,
      sessionId: entry.sessionId,
      mode: "open",
      answer,
    };
  }

  settleQuestionExternally(pendingId: string, reason?: Error): boolean {
    const entry = this.findQuestionEntry(pendingId);
    if (!entry || entry.settled) {
      return false;
    }
    entry.settled = true;
    clearTimeout(entry.timer);
    this.questions.delete(entry.pendingId);
    if (entry.mode === "open") {
      if (reason) {
        entry.reject(reason);
      } else {
        entry.reject(new Error(`Question ${entry.pendingId} settled externally`));
      }
    }
    return true;
  }

  hasPendingQuestionForSession(sessionId: string): boolean {
    for (const entry of this.questions.values()) {
      if (!entry.settled && entry.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  getPendingQuestionIdsForSession(sessionId: string): string[] {
    const ids: string[] = [];
    for (const entry of this.questions.values()) {
      if (!entry.settled && entry.sessionId === sessionId) {
        ids.push(entry.pendingId);
      }
    }
    return ids;
  }

  getPendingApprovalIdsForSession(sessionId: string): string[] {
    const ids: string[] = [];
    for (const entry of this.approvals.values()) {
      if (!entry.settled && entry.sessionId === sessionId) {
        ids.push(entry.pendingId);
      }
    }
    return ids;
  }

  listApprovals(): PendingApprovalView[] {
    const list: PendingApprovalView[] = [];
    for (const entry of this.approvals.values()) {
      if (!entry.settled) {
        list.push(this.toApprovalView(entry));
      }
    }
    return list;
  }

  listQuestions(): PendingQuestionView[] {
    const list: PendingQuestionView[] = [];
    for (const entry of this.questions.values()) {
      if (!entry.settled) {
        list.push(this.toQuestionView(entry));
      }
    }
    return list;
  }

  recordStopped(entry: RecentStoppedView): void {
    this.recentStopped.unshift(entry);
    if (this.recentStopped.length > MAX_RECENT_STOPPED) {
      this.recentStopped.length = MAX_RECENT_STOPPED;
    }
  }

  listRecentStopped(): RecentStoppedView[] {
    return [...this.recentStopped];
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.approvals.values()) {
      if (!entry.settled) {
        entry.settled = true;
        clearTimeout(entry.timer);
        entry.resolve("rejected");
      }
    }
    this.approvals.clear();

    for (const entry of this.questions.values()) {
      if (!entry.settled) {
        entry.settled = true;
        clearTimeout(entry.timer);
        if (entry.mode === "open") {
          entry.reject(new Error("dsh-hermes-bridge disposed"));
        }
      }
    }
    this.questions.clear();
    this.sessionAutoApproved.clear();
  }

  private toApprovalView(entry: PendingApprovalEntry): PendingApprovalView {
    return {
      pendingId: entry.pendingId,
      seqNo: entry.seqNo,
      shortId: entry.shortId,
      sessionId: entry.sessionId,
      taskTitle: entry.taskTitle,
      cwd: entry.cwd,
      toolName: entry.toolName,
      ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
      argumentsPreview: entry.argumentsPreview,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  }

  private toQuestionView(entry: PendingQuestionEntry): PendingQuestionView {
    return {
      pendingId: entry.pendingId,
      seqNo: entry.seqNo,
      shortId: entry.shortId,
      sessionId: entry.sessionId,
      taskTitle: entry.taskTitle,
      cwd: entry.cwd,
      ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
      mode: entry.mode,
      questions: entry.questions,
      questionText: formatQuestionText(entry.questions),
      options: flattenQuestionOptions(entry.questions),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  }
}
