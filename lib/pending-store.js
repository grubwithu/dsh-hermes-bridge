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
function matchApprovalIntent(q, answerText) {
    if (q.intent?.kind === "approval") {
        const normalized = answerText.trim().toLowerCase();
        if (q.intent.always && /^(总是|以后都|始终|always|allow[- ]?always|always[- ]?allow)$/i.test(normalized)) {
            return q.intent.always;
        }
        if (/^(同意|允许|放行|批准|通过|确认|好的?|可以|行|是|yes|ok|okay|approve|allow)$/i.test(normalized)) {
            return q.intent.approve;
        }
        if (/^(拒绝|不同意|取消|不行|不要|否|不|no|reject|deny|decline|cancel)$/i.test(normalized)) {
            return q.intent.reject;
        }
    }
    if (q.intent?.kind === "plan-review") {
        const normalized = answerText.trim().toLowerCase();
        if (/^(同意|批准|通过|确认|按这个做|可以|yes|approve|ok)$/i.test(normalized)) {
            return q.intent.approve;
        }
    }
    return undefined;
}
function normalizeOptionBase(text) {
    let s = text.trim();
    // Strip leading letter/number bullet like "A. ", "B: ", "1. "
    s = s.replace(/^(?:[A-Za-z]|[1-9]\d*)[.:：、)\]]\s*/, "");
    // Repeatedly strip trailing parenthetical annotations like "（推荐）", "(Recommended)", "[默认]"
    let prev = "";
    while (s !== prev) {
        prev = s;
        s = s.replace(/\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\])\s*$/, "").trim();
    }
    return s.toLowerCase();
}
const CN_NUM_MAP = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
};
function parseChineseOrArabicNumber(raw) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    }
    return CN_NUM_MAP[trimmed];
}
function matchOptionToken(options, rawToken) {
    const token = rawToken.trim();
    if (!token || options.length === 0) {
        return [];
    }
    // 1. Exact label match (case-insensitive)
    const exact = options.find((opt) => opt.label.trim().toLowerCase() === token.toLowerCase());
    if (exact) {
        return [exact.label];
    }
    // Strip common conversational prefixes like "选", "我选", "选择", "选项", "答案是"
    const cleaned = token
        .replace(/^(?:我?\s*选择?|选项|答案\s*是?|选)\s*/i, "")
        .trim();
    const target = cleaned || token;
    const exactAfterClean = options.find((opt) => opt.label.trim().toLowerCase() === target.toLowerCase());
    if (exactAfterClean) {
        return [exactAfterClean.label];
    }
    // 2. Single letter code match: "A", "b", "A.", "(A)", "[A]", "A: 功能正常", "A. 功能正常"
    const singleLetterMatch = /^(?:[\(\[（【]?\s*([A-Za-z])\s*[\)\]）】]?)(?:[.:：、)\]\s-]+\s*(.+))?$/.exec(target);
    if (singleLetterMatch?.[1]) {
        const letter = singleLetterMatch[1].toUpperCase();
        const rest = singleLetterMatch[2]?.trim();
        const idx = letter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) {
            const candidateOpt = options[idx];
            if (!rest) {
                return [candidateOpt.label];
            }
            const restBase = normalizeOptionBase(rest);
            const optBase = normalizeOptionBase(candidateOpt.label);
            if (!restBase ||
                optBase.includes(restBase) ||
                restBase.includes(optBase) ||
                candidateOpt.label.toLowerCase().includes(rest.toLowerCase())) {
                return [candidateOpt.label];
            }
        }
    }
    // 3. Compact multi-letter combination like "AB", "AC", "ABC" (when all chars are valid option letters A..Z)
    if (/^[A-Za-z]{2,10}$/.test(target)) {
        const upper = target.toUpperCase();
        const indices = [...upper].map((ch) => ch.charCodeAt(0) - 65);
        if (indices.every((idx) => idx >= 0 && idx < options.length)) {
            const labels = [];
            for (const idx of indices) {
                const label = options[idx].label;
                if (!labels.includes(label)) {
                    labels.push(label);
                }
            }
            return labels;
        }
    }
    // 4. Numeric 1-based index match: "1", "2", "第一个", "第2项"
    const numMatch = /^(?:第\s*)?([1-9]\d*|[一二两三四五六七八九十])(?:\s*[个项])?$/.exec(target);
    if (numMatch?.[1]) {
        const num = parseChineseOrArabicNumber(numMatch[1]);
        if (num !== undefined && num >= 1 && num <= options.length) {
            return [options[num - 1].label];
        }
    }
    // 5. Normalized base label match (e.g. "功能正常" matches "功能正常（推荐）")
    const candBase = normalizeOptionBase(target);
    if (candBase.length > 0) {
        const baseMatches = options.filter((opt) => normalizeOptionBase(opt.label) === candBase);
        if (baseMatches.length === 1) {
            return [baseMatches[0].label];
        }
        // 6. Unambiguous prefix or substring match
        if (candBase.length >= 2) {
            const prefixMatches = options.filter((opt) => {
                const optBase = normalizeOptionBase(opt.label);
                return (optBase.startsWith(candBase) ||
                    opt.label.toLowerCase().startsWith(candBase) ||
                    (optBase.length >= 2 && candBase.startsWith(optBase)));
            });
            if (prefixMatches.length === 1) {
                return [prefixMatches[0].label];
            }
            const substrMatches = options.filter((opt) => {
                const optBase = normalizeOptionBase(opt.label);
                return (opt.label.toLowerCase().includes(candBase) ||
                    (optBase.length >= 2 && candBase.includes(optBase)));
            });
            if (substrMatches.length === 1) {
                return [substrMatches[0].label];
            }
        }
    }
    return [];
}
function splitCandidateParts(text) {
    return text
        .split(/[,，、;；/\n]+|(?:\s+(?:和|与|及|以及|and)\s+)|(?<=[A-Za-z])(?:和|与|及)(?=[A-Za-z])/i)
        .map((part) => part.trim())
        .filter(Boolean);
}
function resolveSingleQuestionAnswer(q, rawAnswerText, rawSelectedOptions) {
    const options = q.options ?? [];
    const trimmedText = rawAnswerText.trim();
    const normalizedSelectedInput = rawSelectedOptions.map((item) => item.trim()).filter(Boolean);
    const matchedLabels = [];
    const addMatched = (labels) => {
        for (const label of labels) {
            if (!matchedLabels.includes(label)) {
                matchedLabels.push(label);
            }
        }
    };
    const matchCandidateString = (candidate) => {
        const exactWhole = options.find((opt) => opt.label.trim().toLowerCase() === candidate.trim().toLowerCase());
        if (exactWhole) {
            addMatched([exactWhole.label]);
            return;
        }
        const parts = splitCandidateParts(candidate);
        if (q.multiSelect && parts.length > 1) {
            for (const sub of parts) {
                addMatched(matchOptionToken(options, sub));
            }
            if (matchedLabels.length > 0) {
                return;
            }
        }
        const direct = matchOptionToken(options, candidate);
        if (direct.length > 0) {
            addMatched(direct);
        }
        else if (parts.length > 1) {
            for (const sub of parts) {
                addMatched(matchOptionToken(options, sub));
            }
        }
    };
    if (normalizedSelectedInput.length > 0 && options.length > 0) {
        for (const candidate of normalizedSelectedInput) {
            matchCandidateString(candidate);
        }
    }
    if (matchedLabels.length === 0 && options.length > 0 && trimmedText.length > 0) {
        matchCandidateString(trimmedText);
    }
    if (matchedLabels.length === 0 && trimmedText.length > 0) {
        const intentLabel = matchApprovalIntent(q, trimmedText);
        if (intentLabel) {
            addMatched([intentLabel]);
        }
    }
    if (matchedLabels.length > 0) {
        const finalSelected = q.multiSelect ? matchedLabels : [matchedLabels[0]];
        return {
            id: q.id,
            selected: finalSelected,
        };
    }
    const fallbackCustom = trimmedText ||
        (normalizedSelectedInput.length > 0 ? normalizedSelectedInput.join(", ") : rawAnswerText);
    return {
        id: q.id,
        selected: [],
        custom: fallbackCustom,
    };
}
function extractPerQuestionTextSegments(answerText, questionCount) {
    const trimmed = answerText.trim();
    if (!trimmed || questionCount <= 1) {
        return undefined;
    }
    // Pattern 1: Explicit question markers like "1. A; 2. B", "1选A，2选BC", "第一题：A，第二题：B", "Q1: A Q2: B"
    const markerRegex = /(?:^|[\s,，;；\n])(?:第\s*([1-9]\d*|[一二两三四五六七八九十])\s*[题个项问题]\s*(?:选|选择|是|为|[:：.、)\]])?\s*|Q(?:uestion)?\s*([1-9]\d*)\s*(?:选|选择|[:：.、)\]])\s*|([1-9]\d*)\s*(?:选|选择|[:：.、)\]])\s*)/gi;
    const matches = [];
    let match;
    while ((match = markerRegex.exec(trimmed)) !== null) {
        const rawNum = match[1] ?? match[2] ?? match[3] ?? "";
        const qNum = parseChineseOrArabicNumber(rawNum);
        if (qNum !== undefined && qNum >= 1 && qNum <= questionCount) {
            matches.push({
                qIndex: qNum - 1,
                start: match.index,
                contentStart: match.index + match[0].length,
            });
        }
    }
    if (matches.length >= 2) {
        const byQuestion = new Map();
        for (let i = 0; i < matches.length; i++) {
            const cur = matches[i];
            const next = matches[i + 1];
            const slice = trimmed
                .slice(cur.contentStart, next ? next.start : trimmed.length)
                .replace(/^[\s,，;；:：]+|[\s,，;；]+$/g, "");
            if (slice) {
                byQuestion.set(cur.qIndex, slice);
            }
        }
        if (byQuestion.size > 0) {
            return byQuestion;
        }
    }
    // Pattern 2: Semicolon or newline separated segments matching questionCount (e.g. "A; B, C" or "A\nB, C")
    const semiParts = trimmed
        .split(/[;；\n]+/)
        .map((p) => p.trim())
        .filter(Boolean);
    if (semiParts.length === questionCount) {
        const byQuestion = new Map();
        for (let i = 0; i < questionCount; i++) {
            byQuestion.set(i, semiParts[i]);
        }
        return byQuestion;
    }
    return undefined;
}
function partitionSelectedOptionsByQuestion(questions, selectedOptions) {
    if (questions.length <= 1 || selectedOptions.length === 0) {
        return undefined;
    }
    // Check if items carry explicit question prefixes like "1: A", "2: B, C", "Q1: A"
    const prefixRegex = /^(?:第\s*([1-9]\d*|[一二两三四五六七八九十])\s*[题个项]\s*[:：.、\s]\s*|Q(?:uestion)?\s*([1-9]\d*)\s*[:：.、\s]\s*|([1-9]\d*)\s*[:：.]\s*)(.+)$/i;
    const prefixedMap = new Map();
    let prefixedCount = 0;
    for (const item of selectedOptions) {
        const m = prefixRegex.exec(item.trim());
        if (m) {
            const qNum = parseChineseOrArabicNumber(m[1] ?? m[2] ?? m[3] ?? "");
            const rest = m[4]?.trim();
            if (qNum !== undefined && qNum >= 1 && qNum <= questions.length && rest) {
                prefixedCount++;
                const list = prefixedMap.get(qNum - 1) ?? [];
                list.push(rest);
                prefixedMap.set(qNum - 1, list);
            }
        }
    }
    if (prefixedCount > 0) {
        return prefixedMap;
    }
    // If selectedOptions length equals questions.length, map 1-to-1 positionally
    if (selectedOptions.length === questions.length) {
        const positionalMap = new Map();
        for (let i = 0; i < questions.length; i++) {
            positionalMap.set(i, [selectedOptions[i]]);
        }
        return positionalMap;
    }
    return undefined;
}
export function buildAskUserQuestionAnswer(questions, answerText = "", selectedOptions, perQuestionAnswers) {
    const normalizedSelectedInput = (selectedOptions ?? []).map((item) => item.trim()).filter(Boolean);
    if (Array.isArray(perQuestionAnswers) && perQuestionAnswers.length > 0) {
        const answers = questions.map((q, qIndex) => {
            const explicit = perQuestionAnswers.find((a) => a.questionId !== undefined && a.questionId === q.id) ??
                perQuestionAnswers.find((a) => a.questionIndex !== undefined &&
                    (a.questionIndex === qIndex + 1 || (a.questionIndex === 0 && qIndex === 0))) ??
                perQuestionAnswers[qIndex];
            if (!explicit) {
                return resolveSingleQuestionAnswer(q, answerText, normalizedSelectedInput);
            }
            return resolveSingleQuestionAnswer(q, explicit.answerText ?? "", explicit.selectedOptions ?? []);
        });
        return { answers };
    }
    if (questions.length <= 1) {
        return {
            answers: questions.map((q) => resolveSingleQuestionAnswer(q, answerText, normalizedSelectedInput)),
        };
    }
    const segmentedText = extractPerQuestionTextSegments(answerText, questions.length);
    const partitionedSelected = partitionSelectedOptionsByQuestion(questions, normalizedSelectedInput);
    const answers = questions.map((q, qIndex) => {
        const qText = segmentedText?.get(qIndex) ?? (segmentedText ? "" : answerText);
        const qSelected = partitionedSelected?.get(qIndex) ?? (partitionedSelected ? [] : normalizedSelectedInput);
        return resolveSingleQuestionAnswer(q, qText, qSelected);
    });
    return { answers };
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
        const answer = buildAskUserQuestionAnswer(entry.questions, input.answerText ?? "", input.selectedOptions, input.answers);
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
            questions: entry.questions,
            questionText: formatQuestionText(entry.questions),
            options: flattenQuestionOptions(entry.questions),
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
        };
    }
}
//# sourceMappingURL=pending-store.js.map