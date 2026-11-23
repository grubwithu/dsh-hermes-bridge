import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PendingStore,
  buildAskUserQuestionAnswer,
  validateAndBuildQuestionAnswer,
} from "../lib/pending-store.js";
import type { AskUserQuestionItem, DshAgent } from "../lib/types.js";

describe("PendingStore - approvals", () => {
  it("resolves allowed-once, allowed-session, and rejected decisions", async () => {
    const store = new PendingStore();
    try {
      const a1 = store.addApproval({
        sessionId: "sess_1",
        taskTitle: "Task 1",
        cwd: "/tmp/work",
        toolName: "bash",
        argumentsPreview: "pytest -q",
        timeoutMs: 5_000,
      });
      assert.match(a1.pendingId, /^apr_[0-9a-f]+$/);
      assert.equal(a1.seqNo, 1);
      assert.equal(a1.shortId, "#1");
      assert.equal(store.listApprovals()[0]?.shortId, "#1");
      assert.equal(store.listApprovals().length, 1);

      // Decide using shortId "#1"
      const d1 = store.decideApproval("#1", "allowed-once");
      assert.equal(d1.ok, true);
      if (d1.ok) {
        assert.equal(d1.pendingId, a1.pendingId);
        assert.equal(d1.dshOutcome, "allowed-once");
      }
      assert.equal(await a1.promise, "allowed-once");
      assert.equal(store.listApprovals().length, 0);
      assert.equal(store.isSessionAutoApproved("sess_1"), false);

      const a2 = store.addApproval({
        sessionId: "sess_1",
        taskTitle: "Task 1",
        cwd: "/tmp/work",
        toolName: "bash",
        argumentsPreview: "ls -la",
        timeoutMs: 5_000,
      });
      assert.equal(a2.shortId, "#2");
      // Decide using bare number "2"
      const d2 = store.decideApproval("2", "allowed-session");
      assert.equal(d2.ok, true);
      if (d2.ok) {
        assert.equal(d2.pendingId, a2.pendingId);
        assert.equal(d2.dshOutcome, "allowed-once");
      }
      assert.equal(await a2.promise, "allowed-once");
      assert.equal(store.isSessionAutoApproved("sess_1"), true);

      const a3 = store.addApproval({
        sessionId: "sess_2",
        taskTitle: "Task 2",
        cwd: "/tmp/work",
        toolName: "bash",
        argumentsPreview: "rm -rf /tmp/foo",
        timeoutMs: 5_000,
      });
      const d3 = store.decideApproval(a3.pendingId, "rejected");
      assert.equal(d3.ok, true);
      assert.equal(await a3.promise, "rejected");
    } finally {
      store.dispose();
    }
  });

  it("fails closed as rejected on timeout and returns EXPIRED_OR_RESTARTED afterwards", async () => {
    const store = new PendingStore();
    let timedOutId = "";
    try {
      const a = store.addApproval({
        sessionId: "sess_timeout",
        taskTitle: "Timeout Task",
        cwd: "/tmp/work",
        toolName: "bash",
        argumentsPreview: "sleep 1",
        timeoutMs: 25,
        onTimeout: (id) => {
          timedOutId = id;
        },
      });

      const outcome = await a.promise;
      assert.equal(outcome, "rejected");
      assert.equal(timedOutId, a.pendingId);
      assert.equal(store.listApprovals().length, 0);

      const late = store.decideApproval(a.pendingId, "allowed-once");
      assert.deepEqual(late, {
        ok: false,
        code: "EXPIRED_OR_RESTARTED",
        message: `Approval request "${a.pendingId}" is no longer pending (already decided, timed out, or DSH restarted).`,
      });
    } finally {
      store.dispose();
    }
  });

  it("supports external settlement and session cleanup", async () => {
    const store = new PendingStore();
    try {
      const a = store.addApproval({
        sessionId: "sess_race",
        taskTitle: "Race Task",
        cwd: "/tmp/work",
        toolName: "write_file",
        argumentsPreview: "src/app.ts",
        timeoutMs: 5_000,
      });
      assert.equal(store.settleApprovalExternally(a.pendingId, "allowed-once"), true);
      assert.equal(await a.promise, "allowed-once");
      assert.equal(store.settleApprovalExternally(a.pendingId, "rejected"), false);
      assert.equal(store.decideApproval(a.pendingId, "allowed-once").ok, false);

      const a2 = store.addApproval({
        sessionId: "sess_clear",
        taskTitle: "Clear Task",
        cwd: "/tmp/work",
        toolName: "bash",
        argumentsPreview: "echo hi",
        timeoutMs: 5_000,
      });
      store.decideApproval(a2.pendingId, "allowed-session");
      assert.equal(store.isSessionAutoApproved("sess_clear"), true);
      store.clearSession("sess_clear");
      assert.equal(store.isSessionAutoApproved("sess_clear"), false);
    } finally {
      store.dispose();
    }
  });
});

describe("PendingStore - questions & stopped history", () => {
  const sampleQuestions: AskUserQuestionItem[] = [
    {
      id: "db_choice",
      question: "Which database should we use?",
      options: [
        { label: "PostgreSQL", description: "Relational DB" },
        { label: "SQLite", description: "Embedded DB" },
      ],
    },
  ];

  it("validates strict JSON schema answers (option letters, exact labels, custom text, and error rejection)", async () => {
    const builtByLetter = buildAskUserQuestionAnswer(sampleQuestions, [
      { questionIndex: 1, selected: ["A"] },
    ]);
    assert.deepEqual(builtByLetter, {
      answers: [{ id: "db_choice", selected: ["PostgreSQL"] }],
    });

    const builtCustom = buildAskUserQuestionAnswer(sampleQuestions, [
      { questionIndex: 1, selected: [], custom: "用 DuckDB 做本地分析" },
    ]);
    assert.deepEqual(builtCustom, {
      answers: [{ id: "db_choice", selected: [], custom: "用 DuckDB 做本地分析" }],
    });

    const multiQuestions: AskUserQuestionItem[] = [
      {
        id: "features",
        question: "Enable which features?",
        multiSelect: true,
        options: [{ label: "Metrics" }, { label: "Tracing" }, { label: "Alerts" }],
      },
    ];
    const builtMulti = buildAskUserQuestionAnswer(multiQuestions, [
      { questionIndex: 1, selected: ["A", "C"] },
    ]);
    assert.deepEqual(builtMulti, {
      answers: [{ id: "features", selected: ["Metrics", "Alerts"] }],
    });

    // Multi-question prompt with single-select + multi-select
    const twoQuestions: AskUserQuestionItem[] = [
      {
        id: "q_single",
        question: "第一题（单选）：请选择一个选项。",
        options: [
          { label: "功能正常（推荐）" },
          { label: "存在异常" },
        ],
      },
      {
        id: "q_multi",
        question: "第二题（多选）：请勾选任意一项或多项。",
        multiSelect: true,
        options: [
          { label: "日志清晰" },
          { label: "耗时合理" },
          { label: "需要优化" },
        ],
      },
    ];

    assert.deepEqual(
      buildAskUserQuestionAnswer(twoQuestions, [
        { questionIndex: 1, selected: ["A"] },
        { questionIndex: 2, selected: ["A", "C"] },
      ]),
      {
        answers: [
          { id: "q_single", selected: ["功能正常（推荐）"] },
          { id: "q_multi", selected: ["日志清晰", "需要优化"] },
        ],
      },
    );

    // Invalid option string in selected is rejected with INVALID_ANSWER_SCHEMA (NOT silently placed in custom!)
    const badOption = validateAndBuildQuestionAnswer(twoQuestions, [
      { questionIndex: 1, selected: ["功能正常"] },
      { questionIndex: 2, selected: ["A"] },
    ]);
    assert.equal(badOption.ok, false);
    if (!badOption.ok) {
      assert.equal(badOption.code, "INVALID_ANSWER_SCHEMA");
    }

    // Passing multiple options to a single-select question is rejected
    const badMultiOnSingle = validateAndBuildQuestionAnswer(twoQuestions, [
      { questionIndex: 1, selected: ["A", "B"] },
      { questionIndex: 2, selected: ["A"] },
    ]);
    assert.equal(badMultiOnSingle.ok, false);

    // Passing wrong number of answers is rejected
    const badCount = validateAndBuildQuestionAnswer(twoQuestions, [
      { questionIndex: 1, selected: ["A"] },
    ]);
    assert.equal(badCount.ok, false);
  });

  it("resolves open and continued questions via PendingStore", async () => {
    const store = new PendingStore();
    try {
      const q1 = store.addQuestion({
        sessionId: "sess_q1",
        taskTitle: "Q Task",
        cwd: "/tmp/work",
        questions: sampleQuestions,
        timeoutMs: 5_000,
      });
      assert.match(q1.pendingId, /^qst_[0-9a-f]+$/);
      assert.equal(q1.shortId, "#1");
      assert.equal(store.hasPendingQuestionForSession("sess_q1"), true);

      // Answer using shortId "#1" and strict JSON schema
      const ans1 = store.answerQuestion("#1", {
        answers: [{ questionIndex: 1, selected: ["A"] }],
      });
      assert.equal(ans1.ok, true);
      if (ans1.ok) {
        assert.equal(ans1.pendingId, q1.pendingId);
        assert.equal(ans1.mode, "open");
      }
      assert.deepEqual(await q1.promise, {
        answers: [{ id: "db_choice", selected: ["PostgreSQL"] }],
      });
      assert.equal(store.hasPendingQuestionForSession("sess_q1"), false);

      // Continued question path (askTimed fallback)
      const q2 = store.addQuestion({
        sessionId: "sess_q2",
        taskTitle: "Continued Task",
        cwd: "/tmp/work",
        questions: sampleQuestions,
        callId: "call_timed_1",
        timeoutMs: 5_000,
      });
      q2.promise.catch(() => {});

      const mockAgent: DshAgent = {
        id: "sess_q2",
        session: { id: "sess_q2", header: { id: "sess_q2" } },
        cancel: () => {},
      };
      assert.equal(store.markQuestionContinued(q2.pendingId, mockAgent, "call_timed_1"), true);

      let forwardedCall: { callId: string; selected: string[] } | undefined;
      const ans2 = store.answerQuestion(
        q2.pendingId,
        {
          answers: [{ questionIndex: 1, selected: ["B"] }],
        },
        {
          answer(_agent, callId, answer) {
            forwardedCall = {
              callId,
              selected: answer.answers[0]?.selected ?? [],
            };
            return true;
          },
        },
      );
      assert.equal(ans2.ok, true);
      if (ans2.ok) {
        assert.equal(ans2.mode, "continued");
      }
      assert.deepEqual(forwardedCall, { callId: "call_timed_1", selected: ["SQLite"] });
    } finally {
      store.dispose();
    }
  });

  it("caps recentStopped history at 20 entries", () => {
    const store = new PendingStore();
    try {
      for (let i = 0; i < 25; i++) {
        store.recordStopped({
          sessionId: `sess_${i}`,
          taskTitle: `Task ${i}`,
          cwd: "/tmp",
          reasonKind: "completed",
          durationMs: 12_000,
          summary: `done ${i}`,
          stoppedAt: new Date().toISOString(),
        });
      }
      const list = store.listRecentStopped();
      assert.equal(list.length, 20);
      assert.equal(list[0]?.sessionId, "sess_24");
      assert.equal(list[19]?.sessionId, "sess_5");
    } finally {
      store.dispose();
    }
  });
});
