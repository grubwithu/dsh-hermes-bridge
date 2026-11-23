import type { ApprovalDecision, AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionOption, DshAgent, DshApprovalOutcome, DshUserQuestionsService, PendingApprovalView, PendingQuestionView, PerQuestionAnswerInput, RecentStoppedView } from "./types.js";
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
export type DecideApprovalResult = {
    ok: true;
    pendingId: string;
    seqNo: number;
    shortId: string;
    sessionId: string;
    decision: ApprovalDecision;
    dshOutcome: "allowed-once" | "rejected";
} | {
    ok: false;
    code: "EXPIRED_OR_RESTARTED";
    message: string;
};
export type AnswerQuestionResult = {
    ok: true;
    pendingId: string;
    seqNo: number;
    shortId: string;
    sessionId: string;
    mode: "open" | "continued";
    answer: AskUserQuestionAnswer;
} | {
    ok: false;
    code: "EXPIRED_OR_RESTARTED" | "USER_QUESTIONS_UNAVAILABLE" | "REPLY_ERROR";
    message: string;
};
export declare function createQuestionTimeoutError(pendingId: string): Error & {
    code: string;
};
export declare function optionIndexToLetter(index: number): string;
export declare function formatQuestionOptionsInline(options: AskUserQuestionOption[]): string;
export declare function formatSingleQuestionBlock(q: AskUserQuestionItem, index: number): string;
export declare function formatQuestionText(questions: AskUserQuestionItem[]): string;
export declare function buildAskUserQuestionAnswer(questions: AskUserQuestionItem[], answerText?: string, selectedOptions?: string[], perQuestionAnswers?: PerQuestionAnswerInput[]): AskUserQuestionAnswer;
export declare class PendingStore {
    private readonly approvals;
    private readonly questions;
    private readonly sessionAutoApproved;
    private readonly recentStopped;
    private seqCounter;
    private disposed;
    nextShortId(): {
        seqNo: number;
        shortId: string;
    };
    private findApprovalEntry;
    private findQuestionEntry;
    addApproval(input: AddApprovalInput): {
        pendingId: string;
        seqNo: number;
        shortId: string;
        promise: Promise<DshApprovalOutcome>;
        expiresAt: string;
        view: PendingApprovalView;
    };
    decideApproval(pendingId: string, decision: ApprovalDecision): DecideApprovalResult;
    settleApprovalExternally(pendingId: string, outcome?: DshApprovalOutcome): boolean;
    isSessionAutoApproved(sessionId: string): boolean;
    clearSession(sessionId: string): void;
    addQuestion(input: AddQuestionInput): {
        pendingId: string;
        seqNo: number;
        shortId: string;
        promise: Promise<AskUserQuestionAnswer>;
        expiresAt: string;
        view: PendingQuestionView;
    };
    markQuestionContinued(pendingId: string, agent: DshAgent, callId: string): boolean;
    answerQuestion(pendingId: string, input: {
        answerText?: string;
        selectedOptions?: string[];
        answers?: PerQuestionAnswerInput[];
    }, userQuestionsProvider?: DshUserQuestionsService | (() => DshUserQuestionsService | undefined)): AnswerQuestionResult;
    settleQuestionExternally(pendingId: string, reason?: Error): boolean;
    hasPendingQuestionForSession(sessionId: string): boolean;
    getPendingQuestionIdsForSession(sessionId: string): string[];
    getPendingApprovalIdsForSession(sessionId: string): string[];
    listApprovals(): PendingApprovalView[];
    listQuestions(): PendingQuestionView[];
    recordStopped(entry: RecentStoppedView): void;
    listRecentStopped(): RecentStoppedView[];
    dispose(): void;
    private toApprovalView;
    private toQuestionView;
}
//# sourceMappingURL=pending-store.d.ts.map