import type { BridgeEventState, BridgeLogger, BridgeWebhookPayload } from "./types.js";
export interface WebhookEventInput {
    seqNo?: number;
    shortId?: string;
    sessionId: string;
    taskTitle: string;
    cwd: string;
    state: BridgeEventState;
    stateLabel: string;
    pendingId?: string;
    summary: string;
    details: Record<string, unknown>;
}
export interface WebhookClientOptions {
    url: string;
    secret?: string;
    logger?: BridgeLogger;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelaysMs?: number[];
}
export interface WebhookSendResult {
    ok: boolean;
    eventId: string;
    status?: number;
    attempts: number;
    error?: string;
}
export declare function generateEventId(date?: Date): string;
export declare function signWebhookPayload(secret: string, timestampSec: string, rawBody: string): string;
export declare class WebhookClient {
    private readonly url;
    private readonly secret;
    private readonly logger?;
    private readonly fetchImpl;
    private readonly timeoutMs;
    private readonly maxAttempts;
    private readonly retryDelaysMs;
    constructor(options: WebhookClientOptions);
    buildPayload(input: WebhookEventInput, now?: Date): BridgeWebhookPayload;
    send(input: WebhookEventInput): Promise<WebhookSendResult>;
}
//# sourceMappingURL=webhook-client.d.ts.map