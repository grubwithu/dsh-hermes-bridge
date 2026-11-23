import { randomBytes } from "node:crypto";
const MAX_RECENT_STOPPED = 20;
export function createQuestionTimeoutError(pendingId) {
    const err = new Error(`Pending question ${pendingId} timed out waiting for user response`);
    err.name = "QuestionTimeoutError";
    err.code = "QUESTION_TIMED_OUT";
    return err;
}
function generateShortId(prefix, existing) {
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
export function optionIndexToLetter(index) {
    if (index < 0)
        return "?";
    let n = index;
    let out = "";
    do {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
}
export function formatQuestionOptionsInline(options) {
    return options
        .map((opt, idx) => `${optionIndexToLetter(idx)}. ${opt.label}`)
        .join(" / ");
}
const CN_INDEX_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function toChineseQuestionTitle(qNum) {
    const cn = CN_INDEX_LABELS[qNum - 1] ?? String(qNum);
    return `第${cn}题`;
}
function hasSelectModeTag(text) {
    return /(?:（(?:单选|多选)）|\((?:单选|多选)\)|\[(?:单选|多选)\])/.test(text);
}
function ensureSelectModeTag(text, modeTag, shouldInclude) {
    if (!shouldInclude || hasSelectModeTag(text)) {
        return text;
    }
    return `${text}（${modeTag}）`;
}
export function formatSingleQuestionBlock(q, index) {
    const qNum = index + 1;
    const opts = q.options ?? [];
    const hasChoiceMode = opts.length > 0 || Boolean(q.multiSelect);
    const modeTag = q.multiSelect ? "多选" : "单选";
    let rawQuestion = q.question.trim().replace(/^\d+[.、]\s*/, "");
    const headerRaw = q.header?.trim().replace(/^\d+[.、]\s*/, "") ?? "";
    const colonMatch = /^([^：:\n]{1,30})[：:]\s*(.+)$/s.exec(rawQuestion);
    let titlePart;
    let promptPart;
    if (headerRaw.length > 0) {
        titlePart = ensureSelectModeTag(headerRaw, modeTag, hasChoiceMode);
        if (colonMatch && colonMatch[1].trim() === headerRaw) {
            promptPart = colonMatch[2].trim();
        }
        else {
            promptPart = rawQuestion;
        }
    }
    else if (colonMatch) {
        titlePart = ensureSelectModeTag(colonMatch[1].trim(), modeTag, hasChoiceMode);
        promptPart = colonMatch[2].trim();
    }
    else {
        titlePart = ensureSelectModeTag(toChineseQuestionTitle(qNum), modeTag, hasChoiceMode);
        promptPart = rawQuestion;
    }
    if (q.detail && q.detail.trim().length > 0) {
        const detailText = q.detail.trim();
        promptPart = promptPart ? `${promptPart}（${detailText}）` : detailText;
    }
    const headingLine = promptPart
        ? `**${qNum}. ${titlePart}**——${promptPart}`
        : `**${qNum}. ${titlePart}**`;
    if (opts.length === 0) {
        return headingLine;
    }
    const optionLines = opts.map((opt, optIdx) => {
        const letter = optionIndexToLetter(optIdx);
        const rawLabel = opt.label.trim();
        const labelWithMode = ensureSelectModeTag(rawLabel, modeTag, true);
        const desc = opt.description?.trim();
        return desc
            ? `- **${letter}.** ${labelWithMode}　${desc}`
            : `- **${letter}.** ${labelWithMode}`;
    });
    return [headingLine, ...optionLines].join("\n");
}
export function formatQuestionText(questions) {
    return questions
        .map((q, index) => formatSingleQuestionBlock(q, index))
        .join("\n\n");
}
function flattenQuestionOptions(questions) {
    const seen = new Set();
    const out = [];
    for (const q of questions) {
        for (const [optIdx, opt] of (q.options ?? []).entries()) {
            const code = optionIndexToLetter(optIdx);
            const dedupKey = `${q.id}:${code}:${opt.label}`;
            if (!seen.has(dedupKey)) {
                seen.add(dedupKey);
                out.push(opt.description
                    ? { code, label: opt.label, description: opt.description }
                    : { code, label: opt.label });
            }
        }
    }
    return out;
}
function resolveStrictOptionSelection(options, rawSelection, questionNumber) {
    const token = rawSelection.trim();
    const validSummary = options
        .map((opt, idx) => `${optionIndexToLetter(idx)}: ${opt.label}`)
        .join(", ");
    if (!token) {
        return {
            ok: false,
            message: `Question ${questionNumber} received an empty string in "selected". Valid options are: [${validSummary}].`,
        };
    }
    // 1. Option letter code ("A", "B", "C" or "A.")
    const letterMatch = /^([A-Za-z])\.?$/.exec(token);
    if (letterMatch?.[1]) {
        const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) {
            return { ok: true, label: options[idx].label };
        }
        return {
            ok: false,
            message: `Option letter "${token}" is out of range for question ${questionNumber}. Valid options are: [${validSummary}].`,
        };
    }
    // 2. Exact option label match
    const exact = options.find((opt) => opt.label === token);
    if (exact) {
        return { ok: true, label: exact.label };
    }
    return {
        ok: false,
        message: `Option "${token}" does not match any option for question ${questionNumber}. Pass the option letter (${options.map((_, i) => `"${optionIndexToLetter(i)}"`).join(", ")}) in "selected", or use "selected": [] with "custom": "..." for a custom free-text answer. Valid options: [${validSummary}].`,
    };
}
export function validateAndBuildQuestionAnswer(questions, answersInput) {
    if (!Array.isArray(answersInput) || answersInput.length !== questions.length) {
        return {
            ok: false,
            code: "INVALID_ANSWER_SCHEMA",
            message: `Pending prompt has ${questions.length} question(s), but "answers" contains ${Array.isArray(answersInput) ? answersInput.length : 0} item(s). Provide exactly ${questions.length} item(s), one for each question (questionIndex 1..${questions.length}).`,
        };
    }
    const builtAnswers = [];
    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
        const q = questions[qIndex];
        const questionNumber = qIndex + 1;
        const options = q.options ?? [];
        const item = answersInput.find((a) => typeof a.id === "string" && a.id.trim() === q.id) ??
            answersInput.find((a) => a.questionIndex === questionNumber) ??
            (answersInput[qIndex]?.questionIndex === undefined && answersInput[qIndex]?.id === undefined
                ? answersInput[qIndex]
                : undefined);
        if (!item || typeof item !== "object") {
            return {
                ok: false,
                code: "INVALID_ANSWER_SCHEMA",
                message: `Missing answer entry for question ${questionNumber} (id="${q.id}"). Each entry must specify questionIndex=${questionNumber} (or id="${q.id}").`,
            };
        }
        if (!Array.isArray(item.selected) || item.selected.some((s) => typeof s !== "string")) {
            return {
                ok: false,
                code: "INVALID_ANSWER_SCHEMA",
                message: `Invalid "selected" field for question ${questionNumber}: must be an array of strings (e.g. ["A"] or []).`,
            };
        }
        if (item.custom !== undefined && typeof item.custom !== "string") {
            return {
                ok: false,
                code: "INVALID_ANSWER_SCHEMA",
                message: `Invalid "custom" field for question ${questionNumber}: must be a string if provided.`,
            };
        }
        if (options.length === 0 && item.selected.length > 0) {
            return {
                ok: false,
                code: "INVALID_ANSWER_SCHEMA",
                message: `Question ${questionNumber} has no predefined options; pass "selected": [] and provide the user's text in "custom".`,
            };
        }
        if (!q.multiSelect && item.selected.length > 1) {
            return {
                ok: false,
                code: "INVALID_ANSWER_SCHEMA",
                message: `Question ${questionNumber} is single-select, but "selected" contains ${item.selected.length} options (${JSON.stringify(item.selected)}). Pass at most 1 option.`,
            };
        }
        const resolvedLabels = [];
        for (const rawSel of item.selected) {
            const resolved = resolveStrictOptionSelection(options, rawSel, questionNumber);
            if (!resolved.ok) {
                return {
                    ok: false,
                    code: "INVALID_ANSWER_SCHEMA",
                    message: resolved.message,
                };
            }
            if (!resolvedLabels.includes(resolved.label)) {
                resolvedLabels.push(resolved.label);
            }
        }
        const customText = typeof item.custom === "string" && item.custom.trim().length > 0
            ? item.custom.trim()
            : undefined;
        builtAnswers.push({
            id: q.id,
            selected: resolvedLabels,
            ...(customText !== undefined ? { custom: customText } : {}),
        });
    }
    return {
        ok: true,
        answer: { answers: builtAnswers },
    };
}
export function buildAskUserQuestionAnswer(questions, answersInput) {
    const res = validateAndBuildQuestionAnswer(questions, answersInput);
    if (!res.ok) {
        throw new Error(res.message);
    }
    return res.answer;
}
function parseShortSeqRef(ref) {
    const match = /^(?:#|no\.?\s*|编号\s*|apr_|qst_)?0*([1-9]\d*)$/i.exec(ref.trim());
    if (!match?.[1]) {
        return undefined;
    }
    const n = Number(match[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
export class PendingStore {
    approvals = new Map();
    questions = new Map();
    sessionAutoApproved = new Set();
    recentStopped = [];
    seqCounter = 0;
    disposed = false;
    nextShortId() {
        this.seqCounter += 1;
        return {
            seqNo: this.seqCounter,
            shortId: `#${this.seqCounter}`,
        };
    }
    findApprovalEntry(ref) {
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
    findQuestionEntry(ref) {
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
    addApproval(input) {
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
        let resolvePromise;
        const promise = new Promise((resolve) => {
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
        const entry = {
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
    decideApproval(pendingId, decision) {
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
        const dshOutcome = decision === "rejected" ? "rejected" : "allowed-once";
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
    settleApprovalExternally(pendingId, outcome = "cancelled") {
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
    isSessionAutoApproved(sessionId) {
        return this.sessionAutoApproved.has(sessionId);
    }
    clearSession(sessionId) {
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
    addQuestion(input) {
        if (this.disposed) {
            const err = new Error("PendingStore disposed");
            const rejected = Promise.reject(err);
            rejected.catch(() => { });
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
        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
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
        const entry = {
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
    markQuestionContinued(pendingId, agent, callId) {
        const entry = this.findQuestionEntry(pendingId);
        if (!entry || entry.settled) {
            return false;
        }
        entry.mode = "continued";
        entry.agent = agent;
        entry.callId = callId;
        return true;
    }
    answerQuestion(pendingId, input, userQuestionsProvider) {
        const entry = this.findQuestionEntry(pendingId);
        if (!entry || entry.settled) {
            return {
                ok: false,
                code: "EXPIRED_OR_RESTARTED",
                message: `Question "${pendingId}" is no longer pending (already answered, timed out, cancelled, or DSH restarted).`,
            };
        }
        const validated = validateAndBuildQuestionAnswer(entry.questions, input.answers);
        if (!validated.ok) {
            return validated;
        }
        const { answer } = validated;
        if (entry.mode === "continued") {
            const userQuestionsService = typeof userQuestionsProvider === "function"
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
            }
            catch (err) {
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
    settleQuestionExternally(pendingId, reason) {
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
            }
            else {
                entry.reject(new Error(`Question ${entry.pendingId} settled externally`));
            }
        }
        return true;
    }
    hasPendingQuestionForSession(sessionId) {
        for (const entry of this.questions.values()) {
            if (!entry.settled && entry.sessionId === sessionId) {
                return true;
            }
        }
        return false;
    }
    getPendingQuestionIdsForSession(sessionId) {
        const ids = [];
        for (const entry of this.questions.values()) {
            if (!entry.settled && entry.sessionId === sessionId) {
                ids.push(entry.pendingId);
            }
        }
        return ids;
    }
    getPendingApprovalIdsForSession(sessionId) {
        const ids = [];
        for (const entry of this.approvals.values()) {
            if (!entry.settled && entry.sessionId === sessionId) {
                ids.push(entry.pendingId);
            }
        }
        return ids;
    }
    listApprovals() {
        const list = [];
        for (const entry of this.approvals.values()) {
            if (!entry.settled) {
                list.push(this.toApprovalView(entry));
            }
        }
        return list;
    }
    listQuestions() {
        const list = [];
        for (const entry of this.questions.values()) {
            if (!entry.settled) {
                list.push(this.toQuestionView(entry));
            }
        }
        return list;
    }
    recordStopped(entry) {
        this.recentStopped.unshift(entry);
        if (this.recentStopped.length > MAX_RECENT_STOPPED) {
            this.recentStopped.length = MAX_RECENT_STOPPED;
        }
    }
    listRecentStopped() {
        return [...this.recentStopped];
    }
    dispose() {
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
    toApprovalView(entry) {
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
    toQuestionView(entry) {
        return {
            pendingId: entry.pendingId,
            seqNo: entry.seqNo,
            shortId: entry.shortId,
            sessionId: entry.sessionId,
            taskTitle: entry.taskTitle,
            cwd: entry.cwd,
            ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
            mode: entry.mode,
            questions: entry.questions.map((q) => ({
                ...q,
                ...(q.options
                    ? {
                        options: q.options.map((opt, idx) => ({
                            code: optionIndexToLetter(idx),
                            ...opt,
                        })),
                    }
                    : {}),
            })),
            questionText: formatQuestionText(entry.questions),
            options: flattenQuestionOptions(entry.questions),
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
        };
    }
}
//# sourceMappingURL=pending-store.js.map