import { createHmac, randomBytes } from "node:crypto";
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

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [500, 1_500];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function generateEventId(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const suffix = randomBytes(2).toString("hex");
  return `evt_${y}${m}${d}_${hh}${mm}${ss}_${suffix}`;
}

export function signWebhookPayload(secret: string, timestampSec: string, rawBody: string): string {
  return createHmac("sha256", secret)
    .update(`${timestampSec}.${rawBody}`, "utf8")
    .digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class WebhookClient {
  private readonly url: string;
  private readonly secret: string;
  private readonly logger?: BridgeLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];

  constructor(options: WebhookClientOptions) {
    this.url = options.url;
    this.secret = (options.secret ?? "").trim();
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  buildPayload(input: WebhookEventInput, now: Date = new Date()): BridgeWebhookPayload {
    const eventId = generateEventId(now);
    return {
      eventId,
      event_type: input.state,
      ...(input.seqNo !== undefined ? { seqNo: input.seqNo } : {}),
      ...(input.shortId !== undefined ? { shortId: input.shortId } : {}),
      timestamp: now.toISOString(),
      sessionId: input.sessionId,
      taskTitle: input.taskTitle,
      cwd: input.cwd,
      state: input.state,
      stateLabel: input.stateLabel,
      ...(input.pendingId !== undefined ? { pendingId: input.pendingId } : {}),
      summary: input.summary,
      details: input.details,
    };
  }

  async send(input: WebhookEventInput): Promise<WebhookSendResult> {
    if (!this.url) {
      return {
        ok: false,
        eventId: generateEventId(),
        attempts: 0,
        error: "hermesWebhookUrl is empty",
      };
    }

    const payload = this.buildPayload(input);
    const rawBody = JSON.stringify(payload);
    let lastError = "";
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const timestampSec = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Request-ID": payload.eventId,
      };

      if (this.secret && this.secret !== "INSECURE_NO_AUTH") {
        headers["X-Webhook-Timestamp"] = timestampSec;
        headers["X-Webhook-Signature-V2"] = signWebhookPayload(this.secret, timestampSec, rawBody);
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
      timeoutHandle.unref?.();

      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body: rawBody,
          signal: controller.signal,
        });
        clearTimeout(timeoutHandle);
        lastStatus = response.status;

        if (response.ok) {
          return {
            ok: true,
            eventId: payload.eventId,
            status: response.status,
            attempts: attempt,
          };
        }

        const responseText = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 200)}` : ""}`;

        if (!isRetryableStatus(response.status) || attempt >= this.maxAttempts) {
          this.logger?.warn(
            `[dsh-hermes-bridge] Webhook POST failed (${lastError}) for ${payload.state} (${payload.eventId})`,
          );
          return {
            ok: false,
            eventId: payload.eventId,
            status: response.status,
            attempts: attempt,
            error: lastError,
          };
        }
      } catch (err) {
        clearTimeout(timeoutHandle);
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt >= this.maxAttempts) {
          this.logger?.warn(
            `[dsh-hermes-bridge] Webhook POST error after ${attempt} attempts for ${payload.state} (${payload.eventId}): ${lastError}`,
          );
          return {
            ok: false,
            eventId: payload.eventId,
            status: lastStatus,
            attempts: attempt,
            error: lastError,
          };
        }
      }

      const delayMs = this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 500;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return {
      ok: false,
      eventId: payload.eventId,
      status: lastStatus,
      attempts: this.maxAttempts,
      error: lastError || "Unknown webhook error",
    };
  }
}
