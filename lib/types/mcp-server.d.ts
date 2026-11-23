import type { BridgeLogger, DshContext } from "./types.js";
import type { PendingStore } from "./pending-store.js";
export interface BridgeMcpServerOptions {
    host: string;
    port: number;
    authToken?: string;
    ctx: DshContext;
    store: PendingStore;
    logger?: BridgeLogger;
}
export declare class BridgeMcpServer {
    private readonly host;
    private readonly port;
    private readonly authToken;
    private readonly ctx;
    private readonly store;
    private readonly logger?;
    private readonly sessions;
    private server;
    private listeningAddress;
    constructor(options: BridgeMcpServerOptions);
    start(): Promise<{
        host: string;
        port: number;
    }>;
    stop(): Promise<void>;
    getAddress(): {
        host: string;
        port: number;
    } | null;
    private authorizeRequest;
    private writeJson;
    private handleHttpRequest;
    private executeTool;
    private collectActiveSessions;
}
//# sourceMappingURL=mcp-server.d.ts.map