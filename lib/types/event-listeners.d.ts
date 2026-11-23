import type { BridgeConfig, BridgeLogger, DshContext, DshSession } from "./types.js";
import type { PendingStore } from "./pending-store.js";
import type { WebhookClient } from "./webhook-client.js";
export declare function getOptionalService<T>(ctx: DshContext, key: "userQuestions" | "sessionTitle" | "agents" | "sessions"): T | undefined;
export interface SessionCaches {
    titles: Map<string, string>;
    firstPrompts: Map<string, string>;
    turnStarts: Map<string, number>;
    lastAssistantTexts: Map<string, string>;
    toolCalls: Map<string, {
        name: string;
        arguments: string;
    }>;
    errorLastSentAt: Map<string, number>;
}
export declare function createSessionCaches(): SessionCaches;
export declare function extractTextFromContent(content: unknown): string;
export declare function extractArgumentsPreview(toolName: string, rawArgs?: string): string;
export declare function resolveSessionMeta(ctx: DshContext, session: DshSession | undefined, caches: SessionCaches, fallbackSessionId?: string): {
    sessionId: string;
    taskTitle: string;
    cwd: string;
};
export interface ClassifiedFailure {
    category: string;
    code: string;
    status?: number;
    message: string;
    summary: string;
}
export declare function classifyLlmFailure(rawFailure: unknown): ClassifiedFailure | null;
export declare function registerEventListeners(ctx: DshContext, config: BridgeConfig, store: PendingStore, webhook: WebhookClient, logger: BridgeLogger, nowFn?: () => number): () => void;
//# sourceMappingURL=event-listeners.d.ts.map