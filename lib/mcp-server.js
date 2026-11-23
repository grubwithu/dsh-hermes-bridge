import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { basename } from "node:path";
import { getOptionalService } from "./event-listeners.js";
const MAX_BODY_BYTES = 1_048_576;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = {
    name: "dsh-hermes-bridge",
    version: "0.1.0",
};
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TOOL_DEFINITIONS = [
    {
        name: "dsh_list_status",
        description: "List all currently pending DSH tool approvals, pending user questions, active DSH sessions, and optionally recently stopped turns.",
        inputSchema: {
            type: "object",
            properties: {
                includeRecentStopped: {
                    type: "boolean",
                    description: "Whether to include recently completed or aborted turns.",
                },
            },
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: true,
        },
    },
    {
        name: "dsh_decide_approval",
        description: "Approve or reject a pending DSH tool call approval request by pendingId or short message number (e.g. '#1', '1', or 'apr_a3f2').",
        inputSchema: {
            type: "object",
            properties: {
                pendingId: {
                    type: "string",
                    description: "The pending approval identifier or short message number (e.g. '#1', '1', or 'apr_a3f2').",
                },
                decision: {
                    type: "string",
                    enum: ["allowed-once", "allowed-session", "rejected"],
                    description: "allowed-once approves this tool call only; allowed-session auto-approves subsequent asks in this session; rejected denies the tool call.",
                },
                reason: {
                    type: "string",
                    description: "Optional human-readable reason for the decision.",
                },
            },
            required: ["pendingId", "decision"],
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: false,
        },
    },
    {
        name: "dsh_answer_question",
        description: "Answer a pending ask_user_question prompt in DSH by pendingId or short message number (e.g. '#2', '2', or 'qst_1b4c') without aborting the turn. Supports option letters ('A', 'B', 'AC'), partial/full option labels, multi-question numbered replies ('1: A; 2: B, C'), or per-question structured answers.",
        inputSchema: {
            type: "object",
            properties: {
                pendingId: {
                    type: "string",
                    description: "The pending question identifier or short message number (e.g. '#2', '2', or 'qst_1b4c').",
                },
                answerText: {
                    type: "string",
                    description: "The user's answer text, option letter(s) (e.g. 'A', 'B, C', '1选A，2选BC'), or custom free-text reply.",
                },
                selectedOptions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional selected option letter(s) (e.g. ['A'], ['A', 'C']) or option labels. For multi-question prompts, you can pass one entry per question (e.g. ['A', 'B, C'] or ['1: A', '2: B, C']).",
                },
                answers: {
                    type: "array",
                    description: "Optional per-question answers when a single ask_user_question prompt contains multiple questions.",
                    items: {
                        type: "object",
                        properties: {
                            questionId: {
                                type: "string",
                                description: "Question id (if known).",
                            },
                            questionIndex: {
                                type: "number",
                                description: "1-based question number (1, 2, ...).",
                            },
                            answerText: {
                                type: "string",
                                description: "Answer text or option letter(s) for this question.",
                            },
                            selectedOptions: {
                                type: "array",
                                items: { type: "string" },
                                description: "Selected option letter(s) ('A', 'B') or option labels for this question.",
                            },
                        },
                        additionalProperties: false,
                    },
                },
            },
            required: ["pendingId"],
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: false,
        },
    },
    {
        name: "dsh_send_instruction",
        description: "Send a new instruction or follow-up message to an active DSH session. Refuses if the session has a pending ask_user_question.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Target DSH session ID.",
                },
                message: {
                    type: "string",
                    description: "The instruction text to deliver to the DSH agent.",
                },
            },
            required: ["sessionId", "message"],
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: false,
        },
    },
    {
        name: "dsh_cancel_session",
        description: "Cancel the currently running turn of a DSH session.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Target DSH session ID.",
                },
                reason: {
                    type: "string",
                    description: "Optional human-readable cancellation reason.",
                },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
        },
    },
];
function deepFreeze(value) {
    if (value !== null && typeof value === "object") {
        Object.freeze(value);
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
    }
    return value;
}
function makeFrozenUserMessage(text) {
    return deepFreeze({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
    });
}
function safeTokenEqual(provided, expected) {
    const a = createHash("sha256").update(provided, "utf8").digest();
    const b = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(a, b);
}
function jsonRpcSuccess(id, result) {
    return {
        jsonrpc: "2.0",
        id,
        result,
    };
}
function jsonRpcError(id, code, message, data) {
    return {
        jsonrpc: "2.0",
        id,
        error: {
            code,
            message,
            ...(data !== undefined ? { data } : {}),
        },
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readRequestBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        req.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                const err = new Error("Payload too large");
                err.statusCode = 413;
                req.destroy(err);
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        req.on("error", (err) => {
            reject(err);
        });
    });
}
export class BridgeMcpServer {
    host;
    port;
    authToken;
    ctx;
    store;
    logger;
    sessions = new Set();
    server = null;
    listeningAddress = null;
    constructor(options) {
        this.host = options.host;
        this.port = options.port;
        this.authToken = (options.authToken ?? "").trim();
        this.ctx = options.ctx;
        this.store = options.store;
        this.logger = options.logger;
    }
    async start() {
        if (this.server) {
            return this.listeningAddress ?? { host: this.host, port: this.port };
        }
        const server = createServer((req, res) => {
            void this.handleHttpRequest(req, res);
        });
        await new Promise((resolve, reject) => {
            const onError = (err) => {
                server.off("listening", onListening);
                reject(err);
            };
            const onListening = () => {
                server.off("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(this.port, this.host);
        });
        this.server = server;
        const addr = server.address();
        this.listeningAddress = {
            host: addr?.address ?? this.host,
            port: addr?.port ?? this.port,
        };
        return this.listeningAddress;
    }
    async stop() {
        const server = this.server;
        this.server = null;
        this.listeningAddress = null;
        this.sessions.clear();
        if (!server) {
            return;
        }
        await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
    }
    getAddress() {
        return this.listeningAddress;
    }
    authorizeRequest(req) {
        if (this.authToken.length > 0) {
            const authHeader = req.headers.authorization ?? "";
            const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
            if (!match?.[1] || !safeTokenEqual(match[1].trim(), this.authToken)) {
                return { ok: false, status: 401, error: "Unauthorized" };
            }
            return { ok: true };
        }
        const remoteAddr = req.socket.remoteAddress ?? "";
        if (!LOOPBACK_ADDRS.has(remoteAddr)) {
            return {
                ok: false,
                status: 403,
                error: "Forbidden: non-loopback client rejected when mcpAuthToken is unset",
            };
        }
        return { ok: true };
    }
    writeJson(res, status, body, extraHeaders = {}) {
        const text = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...extraHeaders,
        });
        res.end(text);
    }
    async handleHttpRequest(req, res) {
        const urlPath = (req.url ?? "/").split("?")[0] || "/";
        if (req.method === "GET" && urlPath === "/health") {
            this.writeJson(res, 200, {
                status: "ok",
                service: SERVER_INFO.name,
                version: SERVER_INFO.version,
            });
            return;
        }
        if (urlPath !== "/mcp") {
            this.writeJson(res, 404, { error: "Not found" });
            return;
        }
        const auth = this.authorizeRequest(req);
        if (!auth.ok) {
            this.writeJson(res, auth.status, { error: auth.error });
            return;
        }
        if (req.method === "GET") {
            res.writeHead(405, {
                Allow: "POST, DELETE",
                "Content-Type": "application/json",
            });
            res.end(JSON.stringify({ error: "Method Not Allowed: SSE stream not offered on GET /mcp" }));
            return;
        }
        if (req.method === "DELETE") {
            const sidHeader = req.headers["mcp-session-id"];
            const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
            if (sid) {
                this.sessions.delete(sid);
            }
            this.writeJson(res, 200, { ok: true });
            return;
        }
        if (req.method !== "POST") {
            res.writeHead(405, {
                Allow: "POST, DELETE",
                "Content-Type": "application/json",
            });
            res.end(JSON.stringify({ error: "Method Not Allowed" }));
            return;
        }
        let rawBody;
        try {
            rawBody = await readRequestBody(req, MAX_BODY_BYTES);
        }
        catch (err) {
            const status = err.statusCode === 413 ? 413 : 400;
            this.writeJson(res, status, jsonRpcError(null, -32700, status === 413 ? "Payload too large" : "Failed to read request body"));
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(rawBody);
        }
        catch {
            this.writeJson(res, 400, jsonRpcError(null, -32700, "Parse error: invalid JSON"));
            return;
        }
        const extraHeaders = {};
        const existingSidHeader = req.headers["mcp-session-id"];
        const existingSid = Array.isArray(existingSidHeader) ? existingSidHeader[0] : existingSidHeader;
        const handleSingle = async (msg) => {
            if (!isRecord(msg) || msg["jsonrpc"] !== "2.0" || typeof msg["method"] !== "string") {
                const id = isRecord(msg) && (typeof msg["id"] === "string" || typeof msg["id"] === "number" || msg["id"] === null)
                    ? msg["id"]
                    : null;
                return jsonRpcError(id, -32600, "Invalid Request");
            }
            const rpc = msg;
            const method = rpc.method;
            const hasId = Object.prototype.hasOwnProperty.call(rpc, "id") && rpc.id !== undefined;
            const id = hasId ? rpc.id : null;
            // Notifications have no id
            if (!hasId) {
                return null;
            }
            try {
                if (method === "initialize") {
                    const params = isRecord(rpc.params) ? rpc.params : {};
                    const requestedVersion = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
                    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
                        ? requestedVersion
                        : DEFAULT_PROTOCOL_VERSION;
                    const sid = existingSid && existingSid.trim() ? existingSid : randomUUID();
                    this.sessions.add(sid);
                    extraHeaders["Mcp-Session-Id"] = sid;
                    return jsonRpcSuccess(id, {
                        protocolVersion,
                        capabilities: {
                            tools: {
                                listChanged: false,
                            },
                        },
                        serverInfo: SERVER_INFO,
                    });
                }
                if (method === "ping") {
                    return jsonRpcSuccess(id, {});
                }
                if (method === "tools/list") {
                    return jsonRpcSuccess(id, { tools: TOOL_DEFINITIONS });
                }
                if (method === "tools/call") {
                    const params = isRecord(rpc.params) ? rpc.params : null;
                    if (!params || typeof params["name"] !== "string") {
                        return jsonRpcError(id, -32602, "Invalid params: tools/call requires a tool name");
                    }
                    const toolName = params["name"];
                    const args = params["arguments"] === undefined ? {} : params["arguments"];
                    if (!isRecord(args)) {
                        return jsonRpcError(id, -32602, "Invalid params: tool arguments must be an object");
                    }
                    const result = await this.executeTool(toolName, args);
                    if ("jsonRpcInvalidParams" in result) {
                        return jsonRpcError(id, -32602, result.jsonRpcInvalidParams);
                    }
                    if ("jsonRpcUnknownTool" in result) {
                        return jsonRpcError(id, -32601, result.jsonRpcUnknownTool);
                    }
                    return jsonRpcSuccess(id, {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result.payload, null, 2),
                            },
                        ],
                        isError: false,
                    });
                }
                return jsonRpcError(id, -32601, `Method not found: ${method}`);
            }
            catch (err) {
                this.logger?.error(`[dsh-hermes-bridge] MCP handler error for ${method}:`, err);
                return jsonRpcError(id, -32603, err instanceof Error ? err.message : "Internal server error");
            }
        };
        if (Array.isArray(parsed)) {
            if (parsed.length === 0) {
                this.writeJson(res, 400, jsonRpcError(null, -32600, "Invalid Request: empty batch"));
                return;
            }
            const responses = [];
            for (const item of parsed) {
                const out = await handleSingle(item);
                if (out !== null) {
                    responses.push(out);
                }
            }
            if (responses.length === 0) {
                res.writeHead(202, extraHeaders);
                res.end();
                return;
            }
            this.writeJson(res, 200, responses, extraHeaders);
            return;
        }
        const out = await handleSingle(parsed);
        if (out === null) {
            res.writeHead(202, extraHeaders);
            res.end();
            return;
        }
        this.writeJson(res, 200, out, extraHeaders);
    }
    async executeTool(name, args) {
        switch (name) {
            case "dsh_list_status": {
                const includeRecentStopped = args["includeRecentStopped"] === true;
                const pendingApprovals = this.store.listApprovals();
                const pendingQuestions = this.store.listQuestions();
                const activeSessions = this.collectActiveSessions();
                return {
                    payload: {
                        ok: true,
                        pendingApprovals,
                        pendingQuestions,
                        activeSessions,
                        ...(includeRecentStopped ? { recentStopped: this.store.listRecentStopped() } : {}),
                    },
                };
            }
            case "dsh_decide_approval": {
                const pendingId = typeof args["pendingId"] === "string" ? args["pendingId"].trim() : "";
                const decision = args["decision"];
                const reason = typeof args["reason"] === "string" ? args["reason"].trim() : undefined;
                if (!pendingId) {
                    return { jsonRpcInvalidParams: "Invalid params: pendingId must be a non-empty string" };
                }
                if (decision !== "allowed-once" &&
                    decision !== "allowed-session" &&
                    decision !== "rejected") {
                    return {
                        jsonRpcInvalidParams: "Invalid params: decision must be one of 'allowed-once', 'allowed-session', or 'rejected'",
                    };
                }
                const result = this.store.decideApproval(pendingId, decision);
                if (!result.ok) {
                    return { payload: result };
                }
                return {
                    payload: {
                        ...result,
                        ...(reason ? { reason } : {}),
                    },
                };
            }
            case "dsh_answer_question": {
                const pendingId = typeof args["pendingId"] === "string" ? args["pendingId"].trim() : "";
                const answerText = typeof args["answerText"] === "string" ? args["answerText"] : undefined;
                const selectedOptionsRaw = args["selectedOptions"];
                const answersRaw = args["answers"];
                if (!pendingId) {
                    return {
                        jsonRpcInvalidParams: "Invalid params: pendingId (non-empty string) is required",
                    };
                }
                if (answerText === undefined &&
                    selectedOptionsRaw === undefined &&
                    answersRaw === undefined) {
                    return {
                        jsonRpcInvalidParams: "Invalid params: at least one of answerText, selectedOptions, or answers must be provided",
                    };
                }
                if (selectedOptionsRaw !== undefined &&
                    (!Array.isArray(selectedOptionsRaw) ||
                        selectedOptionsRaw.some((item) => typeof item !== "string"))) {
                    return {
                        jsonRpcInvalidParams: "Invalid params: selectedOptions must be an array of strings",
                    };
                }
                if (answersRaw !== undefined &&
                    (!Array.isArray(answersRaw) ||
                        answersRaw.some((item) => typeof item !== "object" || item === null || Array.isArray(item)))) {
                    return {
                        jsonRpcInvalidParams: "Invalid params: answers must be an array of objects",
                    };
                }
                const result = this.store.answerQuestion(pendingId, {
                    answerText: answerText ?? "",
                    selectedOptions: selectedOptionsRaw,
                    answers: answersRaw,
                }, () => getOptionalService(this.ctx, "userQuestions"));
                return { payload: result };
            }
            case "dsh_send_instruction": {
                const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"].trim() : "";
                const message = typeof args["message"] === "string" ? args["message"].trim() : "";
                if (!sessionId || !message) {
                    return {
                        jsonRpcInvalidParams: "Invalid params: sessionId and message must be non-empty strings",
                    };
                }
                if (this.store.hasPendingQuestionForSession(sessionId)) {
                    const pendingIds = this.store.getPendingQuestionIdsForSession(sessionId);
                    return {
                        payload: {
                            ok: false,
                            code: "PENDING_QUESTION_EXISTS",
                            sessionId,
                            pendingIds,
                            message: "Session currently has a pending ask_user_question. Refusing agent.inject() to avoid triggering ASK_ABORTED; call dsh_answer_question first.",
                        },
                    };
                }
                const agentsSvc = getOptionalService(this.ctx, "agents");
                const agent = agentsSvc?.get(sessionId);
                if (!agent) {
                    return {
                        payload: {
                            ok: false,
                            code: "SESSION_NOT_FOUND",
                            sessionId,
                            message: `No live DSH agent found for sessionId "${sessionId}".`,
                        },
                    };
                }
                const userMsg = makeFrozenUserMessage(message);
                let deliveryMethod;
                if (agent.status === "idle") {
                    if (typeof agent.followup === "function") {
                        agent.followup(userMsg);
                        deliveryMethod = "followup";
                    }
                    else if (typeof agent.steer === "function") {
                        agent.steer(userMsg);
                        deliveryMethod = "steer";
                    }
                    else if (typeof agent.inject === "function") {
                        agent.inject(userMsg);
                        deliveryMethod = "inject";
                    }
                    else {
                        return {
                            payload: {
                                ok: false,
                                code: "AGENT_UNSUPPORTED",
                                sessionId,
                                message: "Live agent handle has neither followup, steer, nor inject method.",
                            },
                        };
                    }
                }
                else if (typeof agent.inject === "function") {
                    agent.inject(userMsg);
                    deliveryMethod = "inject";
                }
                else if (typeof agent.steer === "function") {
                    agent.steer(userMsg);
                    deliveryMethod = "steer";
                }
                else if (typeof agent.followup === "function") {
                    agent.followup(userMsg);
                    deliveryMethod = "followup";
                }
                else {
                    return {
                        payload: {
                            ok: false,
                            code: "AGENT_UNSUPPORTED",
                            sessionId,
                            message: "Live agent handle has neither inject, steer, nor followup method.",
                        },
                    };
                }
                return {
                    payload: {
                        ok: true,
                        sessionId,
                        deliveryMethod,
                    },
                };
            }
            case "dsh_cancel_session": {
                const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"].trim() : "";
                const reason = typeof args["reason"] === "string" ? args["reason"].trim() : undefined;
                if (!sessionId) {
                    return { jsonRpcInvalidParams: "Invalid params: sessionId must be a non-empty string" };
                }
                const agentsSvc = getOptionalService(this.ctx, "agents");
                const agent = agentsSvc?.get(sessionId);
                if (!agent) {
                    return {
                        payload: {
                            ok: false,
                            code: "SESSION_NOT_FOUND",
                            sessionId,
                            message: `No live DSH agent found for sessionId "${sessionId}".`,
                        },
                    };
                }
                agent.cancel({ kind: "user" });
                return {
                    payload: {
                        ok: true,
                        sessionId,
                        cancelled: true,
                        ...(reason ? { reason } : {}),
                    },
                };
            }
            default:
                return { jsonRpcUnknownTool: `Unknown tool: ${name}` };
        }
    }
    collectActiveSessions() {
        const approvals = this.store.listApprovals();
        const questions = this.store.listQuestions();
        const agentsSvc = getOptionalService(this.ctx, "agents");
        const sessionsSvc = getOptionalService(this.ctx, "sessions");
        const sessionTitleSvc = getOptionalService(this.ctx, "sessionTitle");
        const agents = agentsSvc?.list() ?? [];
        if (agents.length > 0) {
            return agents.map((agent) => {
                const session = agent.session;
                const sessionId = session?.id ?? agent.id;
                const cwd = session?.header?.cwd ?? "";
                const title = session ? sessionTitleSvc?.get(session)?.title : undefined;
                return {
                    sessionId,
                    taskTitle: title?.trim() || (cwd ? basename(cwd) : "") || sessionId,
                    cwd,
                    status: agent.status ?? "unknown",
                    pendingApprovals: approvals.filter((a) => a.sessionId === sessionId).length,
                    pendingQuestions: questions.filter((q) => q.sessionId === sessionId).length,
                    autoApprovedSession: this.store.isSessionAutoApproved(sessionId),
                };
            });
        }
        const sessions = sessionsSvc?.list() ?? [];
        return sessions.map((session) => {
            const sessionId = session.id;
            const cwd = session.header?.cwd ?? "";
            const title = sessionTitleSvc?.get(session)?.title;
            return {
                sessionId,
                taskTitle: title?.trim() || (cwd ? basename(cwd) : "") || sessionId,
                cwd,
                status: "unknown",
                pendingApprovals: approvals.filter((a) => a.sessionId === sessionId).length,
                pendingQuestions: questions.filter((q) => q.sessionId === sessionId).length,
                autoApprovedSession: this.store.isSessionAutoApproved(sessionId),
            };
        });
    }
}
//# sourceMappingURL=mcp-server.js.map