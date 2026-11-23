import z from "@deepseek-ai/schemastery";
import type { BridgeConfig, DshContext } from "./types.js";
import { PendingStore } from "./pending-store.js";
import { WebhookClient } from "./webhook-client.js";
import { BridgeMcpServer } from "./mcp-server.js";
export declare const name = "dsh-hermes-bridge";
export declare const inject: readonly ["agents", "sessions"];
export declare const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, "mcpAuthToken" | "hermesWebhookSecret">;
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    mcpHost: z<string, string, "defined">;
    mcpPort: z<number, number, "defined">;
    mcpAuthToken: z<string, string, "defined">;
    hermesWebhookUrl: z<string, string, "defined">;
    hermesWebhookSecret: z<string, string, "defined">;
    approvalTimeoutMs: z<number, number, "defined">;
    questionTimeoutMs: z<number, number, "defined">;
    notifyOnTurnEndMinDurationMs: z<number, number, "defined">;
    errorDebounceMs: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    mcpHost: z<string, string, "defined">;
    mcpPort: z<number, number, "defined">;
    mcpAuthToken: z<string, string, "defined">;
    hermesWebhookUrl: z<string, string, "defined">;
    hermesWebhookSecret: z<string, string, "defined">;
    approvalTimeoutMs: z<number, number, "defined">;
    questionTimeoutMs: z<number, number, "defined">;
    notifyOnTurnEndMinDurationMs: z<number, number, "defined">;
    errorDebounceMs: z<number, number, "defined">;
}>>, "plain">;
export declare function resolveBridgeConfig(rawConfig?: Partial<BridgeConfig>): BridgeConfig;
export interface BridgeRuntime {
    config: BridgeConfig;
    store: PendingStore;
    webhook: WebhookClient;
    mcpServer: BridgeMcpServer;
    dispose: () => Promise<void>;
}
export declare function apply(ctx: DshContext, rawConfig?: Partial<BridgeConfig>): BridgeRuntime;
export { PendingStore, buildAskUserQuestionAnswer } from "./pending-store.js";
export { WebhookClient, generateEventId, signWebhookPayload } from "./webhook-client.js";
export { registerEventListeners, classifyLlmFailure, extractArgumentsPreview, resolveSessionMeta, } from "./event-listeners.js";
export { BridgeMcpServer } from "./mcp-server.js";
export type * from "./types.js";
//# sourceMappingURL=index.d.ts.map