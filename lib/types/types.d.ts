export type BridgeEventState = "paused_approval" | "paused_question" | "interrupted_error" | "stopped";
export type ApprovalDecision = "allowed-once" | "allowed-session" | "rejected";
export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
export interface BridgeConfig {
    mcpHost: string;
    mcpPort: number;
    mcpAuthToken: string;
    hermesWebhookUrl: string;
    hermesWebhookSecret: string;
    approvalTimeoutMs: number;
    questionTimeoutMs: number;
    notifyOnTurnEndMinDurationMs: number;
    errorDebounceMs: number;
}
export interface BridgeLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug?(...args: unknown[]): void;
}
export interface DshContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
}
export interface DshUserMessage {
    readonly id: string;
    readonly role: "user";
    readonly content: readonly DshContentBlock[];
    readonly source: {
        readonly kind: string;
        [key: string]: unknown;
    };
}
export interface DshSessionHeader {
    readonly id: string;
    readonly cwd?: string;
    readonly origin?: string;
    readonly createdAt?: number;
}
export interface DshSession {
    readonly id: string;
    readonly header: DshSessionHeader;
}
export interface DshAgent {
    readonly id: string;
    readonly session: DshSession;
    readonly status?: "idle" | "running" | string;
    inject?(message: DshUserMessage): void;
    steer?(message: DshUserMessage): void;
    followup?(message: DshUserMessage): void;
    send?(message: DshUserMessage, target: "next-turn" | "next-step", wakeup: boolean): void;
    cancel(cause: {
        readonly kind: "user" | "parent" | "disposed" | "hook";
        readonly reason?: string;
    }, options?: {
        keepInbox?: boolean;
    }): void;
}
export interface DshApprovalRequestEvent {
    readonly agent: DshAgent;
    readonly toolName: string;
    readonly callId?: string;
    readonly reason?: string;
    readonly displayReason?: {
        readonly en: string;
        readonly [locale: string]: string;
    };
    readonly signal?: AbortSignal;
}
export interface AskUserQuestionOption {
    label: string;
    description?: string;
}
export type AskUserQuestionIntent = {
    kind: "plan-review";
    approve: string;
    callId?: string;
} | {
    kind: "approval";
    approve: string;
    reject: string;
    always?: string;
    display?: {
        question?: {
            en: string;
            [locale: string]: string;
        };
        detail?: {
            en: string;
            [locale: string]: string;
        };
        approve?: {
            en: string;
            [locale: string]: string;
        };
    };
};
export interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskUserQuestionOption[];
    multiSelect?: boolean;
    intent?: AskUserQuestionIntent;
}
export interface AskUserQuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
export interface AskUserQuestionAnswer {
    answers: AskUserQuestionAnswerItem[];
}
export interface DshUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: DshAgent;
    signal?: AbortSignal;
    wait?: {
        callId: string;
        timed?: boolean;
    };
}
export interface DshUserQuestionsService {
    answer(agent: DshAgent, callId: string, answer: AskUserQuestionAnswer): boolean;
}
export interface DshSessionTitleService {
    get(session: DshSession): {
        readonly title: string;
    } | undefined;
}
export interface DshSessionEvent {
    readonly seq: number;
    readonly time: number;
    readonly type: string;
    readonly data: Record<string, unknown>;
}
export interface DshContext {
    on(name: string, listener: (...args: any[]) => any, options?: boolean | {
        prepend?: boolean;
        global?: boolean;
    }): () => boolean;
    effect?(callback: () => (() => void | Promise<void>) | void, label?: string): () => void;
    logger?(name?: string): BridgeLogger;
    agents?: {
        get(id: string): DshAgent | undefined;
        list(): DshAgent[];
    };
    sessions?: {
        get(id: string): DshSession | undefined;
        list(): DshSession[];
    };
    sessionTitle?: DshSessionTitleService;
    userQuestions?: DshUserQuestionsService;
}
export interface BridgeWebhookPayload {
    eventId: string;
    event_type: BridgeEventState;
    timestamp: string;
    sessionId: string;
    taskTitle: string;
    cwd: string;
    state: BridgeEventState;
    stateLabel: string;
    pendingId?: string;
    summary: string;
    details: Record<string, unknown>;
}
export interface PendingApprovalView {
    pendingId: string;
    sessionId: string;
    taskTitle: string;
    cwd: string;
    toolName: string;
    callId?: string;
    argumentsPreview: string;
    reason?: string;
    createdAt: string;
    expiresAt: string;
}
export interface PendingQuestionView {
    pendingId: string;
    sessionId: string;
    taskTitle: string;
    cwd: string;
    callId?: string;
    mode: "open" | "continued";
    questions: AskUserQuestionItem[];
    questionText: string;
    options: Array<{
        label: string;
        description?: string;
    }>;
    createdAt: string;
    expiresAt: string;
}
export interface RecentStoppedView {
    sessionId: string;
    taskTitle: string;
    cwd: string;
    reasonKind: string;
    durationMs: number;
    summary: string;
    stoppedAt: string;
}
export interface ActiveSessionView {
    sessionId: string;
    taskTitle: string;
    cwd: string;
    status: string;
    pendingApprovals: number;
    pendingQuestions: number;
    autoApprovedSession: boolean;
}
//# sourceMappingURL=types.d.ts.map