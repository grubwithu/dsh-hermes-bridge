import z from "@deepseek-ai/schemastery";
import type { BridgeConfig, BridgeLogger, DshContext } from "./types.js";
import { PendingStore } from "./pending-store.js";
import { WebhookClient } from "./webhook-client.js";
import { registerEventListeners } from "./event-listeners.js";
import { BridgeMcpServer } from "./mcp-server.js";

export const name = "dsh-hermes-bridge";
export const inject = ["agents", "sessions", "userQuestions", "sessionTitle"] as const;

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, "mcpAuthToken" | "hermesWebhookSecret"> = {
  mcpHost: "127.0.0.1",
  mcpPort: 8790,
  hermesWebhookUrl: "http://127.0.0.1:8644/webhooks/dsh-events",
  approvalTimeoutMs: 300_000,
  questionTimeoutMs: 1_800_000,
  notifyOnTurnEndMinDurationMs: 0,
  errorDebounceMs: 60_000,
};

export const Config = z.object({
  mcpHost: z
    .string()
    .default(DEFAULT_BRIDGE_CONFIG.mcpHost)
    .description("Loopback host address for the local StreamableHTTP MCP server."),
  mcpPort: z
    .number()
    .step(1)
    .min(0)
    .max(65535)
    .default(DEFAULT_BRIDGE_CONFIG.mcpPort)
    .description("Port for the local StreamableHTTP MCP server."),
  mcpAuthToken: z
    .string()
    .default("")
    .description("Bearer token for MCP authentication (falls back to DSH_HERMES_MCP_TOKEN)."),
  hermesWebhookUrl: z
    .string()
    .default(DEFAULT_BRIDGE_CONFIG.hermesWebhookUrl)
    .description("Hermes local webhook endpoint URL."),
  hermesWebhookSecret: z
    .string()
    .default("")
    .description("HMAC-SHA256 V2 secret matching the Hermes webhook route (falls back to DSH_HERMES_WEBHOOK_SECRET)."),
  approvalTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_BRIDGE_CONFIG.approvalTimeoutMs)
    .description("Approval wait timeout in milliseconds before failing closed as rejected."),
  questionTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_BRIDGE_CONFIG.questionTimeoutMs)
    .description("User question wait timeout in milliseconds."),
  notifyOnTurnEndMinDurationMs: z
    .number()
    .step(1)
    .min(0)
    .default(DEFAULT_BRIDGE_CONFIG.notifyOnTurnEndMinDurationMs)
    .description("Minimum turn duration in milliseconds to send completed turn/end notifications."),
  errorDebounceMs: z
    .number()
    .step(1)
    .min(0)
    .default(DEFAULT_BRIDGE_CONFIG.errorDebounceMs)
    .description("Debounce window in milliseconds per session and error category."),
});

export function resolveBridgeConfig(rawConfig?: Partial<BridgeConfig>): BridgeConfig {
  const parsed = Config(rawConfig ?? {});
  return {
    mcpHost: parsed.mcpHost.trim() || DEFAULT_BRIDGE_CONFIG.mcpHost,
    mcpPort: parsed.mcpPort,
    mcpAuthToken: parsed.mcpAuthToken.trim() || (process.env["DSH_HERMES_MCP_TOKEN"] ?? "").trim(),
    hermesWebhookUrl: parsed.hermesWebhookUrl.trim() || DEFAULT_BRIDGE_CONFIG.hermesWebhookUrl,
    hermesWebhookSecret:
      parsed.hermesWebhookSecret.trim() || (process.env["DSH_HERMES_WEBHOOK_SECRET"] ?? "").trim(),
    approvalTimeoutMs: parsed.approvalTimeoutMs,
    questionTimeoutMs: parsed.questionTimeoutMs,
    notifyOnTurnEndMinDurationMs: parsed.notifyOnTurnEndMinDurationMs,
    errorDebounceMs: parsed.errorDebounceMs,
  };
}

function createFallbackLogger(): BridgeLogger {
  return {
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: (...args: unknown[]) => console.debug(...args),
  };
}

export interface BridgeRuntime {
  config: BridgeConfig;
  store: PendingStore;
  webhook: WebhookClient;
  mcpServer: BridgeMcpServer;
  dispose: () => Promise<void>;
}

export function apply(ctx: DshContext, rawConfig?: Partial<BridgeConfig>): BridgeRuntime {
  const config = resolveBridgeConfig(rawConfig);
  const logger = ctx.logger?.(name) ?? createFallbackLogger();

  if (!config.mcpAuthToken) {
    logger.warn(
      "[dsh-hermes-bridge] mcpAuthToken is empty; MCP HTTP server will accept loopback clients only without Bearer authentication.",
    );
  }
  if (!config.hermesWebhookSecret) {
    logger.warn(
      "[dsh-hermes-bridge] hermesWebhookSecret is empty; outgoing webhook requests will be sent unsigned.",
    );
  }

  const store = new PendingStore();
  const webhook = new WebhookClient({
    url: config.hermesWebhookUrl,
    secret: config.hermesWebhookSecret,
    logger,
  });
  const mcpServer = new BridgeMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    authToken: config.mcpAuthToken,
    ctx,
    store,
    logger,
  });

  const disposeListeners = registerEventListeners(ctx, config, store, webhook, logger);

  void mcpServer
    .start()
    .then((addr) => {
      logger.info(
        `[dsh-hermes-bridge] MCP StreamableHTTP server listening at http://${addr.host}:${addr.port}/mcp`,
      );
    })
    .catch((err) => {
      logger.error("[dsh-hermes-bridge] Failed to start MCP HTTP server:", err);
    });

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    disposeListeners();
    store.dispose();
    await mcpServer.stop();
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => dispose(), "dsh-hermes-bridge: lifecycle");
  } else {
    ctx.on("dispose", () => dispose());
  }

  return {
    config,
    store,
    webhook,
    mcpServer,
    dispose,
  };
}

export {
  PendingStore,
  buildAskUserQuestionAnswer,
  validateAndBuildQuestionAnswer,
  optionIndexToLetter,
  formatQuestionOptionsInline,
  formatSingleQuestionBlock,
  formatQuestionText,
} from "./pending-store.js";
export { WebhookClient, generateEventId, signWebhookPayload } from "./webhook-client.js";
export {
  registerEventListeners,
  classifyLlmFailure,
  extractArgumentsPreview,
  resolveSessionMeta,
  getOptionalService,
  formatQuestionsSummary,
} from "./event-listeners.js";
export { BridgeMcpServer } from "./mcp-server.js";
export type * from "./types.js";
