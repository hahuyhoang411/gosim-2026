import { describe, expect, test } from "bun:test";
import {
  appendWireConversationEntry,
  createWireConversationState,
  registerWireRequest,
  resolveWireRequest,
  wireConversationSnapshot,
  applyReplayWireEvent,
  applyReplayWireRequest,
} from "../../server/wireConversation.js";

describe("Wire conversation reconnect state", () => {
  test("snapshots chat entries and unresolved live requests for browser reconnect", () => {
    const state = createWireConversationState(7);
    appendWireConversationEntry(state, "user", "please decide", "prompt", { id: "user-1", createdAt: 100 });
    appendWireConversationEntry(state, "assistant", "I need input", "wire", { id: "assistant-1", createdAt: 101 });
    registerWireRequest(state, {
      rpcId: "rpc-question",
      params: {
        type: "QuestionRequest",
        payload: {
          id: "question-1",
          questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      },
    });

    const snapshot = wireConversationSnapshot(state);

    expect(snapshot.entries.map((entry) => entry.text)).toEqual(["please decide", "I need input", "Ship it?"]);
    expect(snapshot.requests).toEqual([
      {
        requestId: "question-1",
        requestType: "QuestionRequest",
        payload: {
          id: "question-1",
          questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      },
    ]);
  });

  test("dedupes replayed content and never exposes replayed requests as actionable pending cards", () => {
    const state = createWireConversationState(3);

    applyReplayWireEvent(state, { type: "TurnBegin", payload: { user_input: "pick a language" } });
    applyReplayWireEvent(state, { type: "ContentPart", payload: { type: "text", text: "I need one answer" } });
    applyReplayWireEvent(state, { type: "ContentPart", payload: { type: "text", text: "I need one answer" } });
    applyReplayWireRequest(state, {
      rpcId: "rpc-replay-question",
      params: {
        type: "QuestionRequest",
        payload: {
          id: "question-replay-1",
          questions: [{ question: "Which one?", options: [{ label: "A" }] }],
        },
      },
    });

    const snapshot = wireConversationSnapshot(state);

    expect(snapshot.entries.map((entry) => entry.text)).toEqual([
      "pick a language",
      "I need one answer",
      "Which one?",
    ]);
    expect(snapshot.requests).toEqual([]);
  });

  test("resolving a pending request removes it from reconnect snapshots", () => {
    const state = createWireConversationState(9);
    registerWireRequest(state, {
      rpcId: "rpc-approval",
      params: {
        type: "ApprovalRequest",
        payload: { id: "approval-1", description: "Run shell command" },
      },
    });

    expect(wireConversationSnapshot(state).requests).toHaveLength(1);
    expect(resolveWireRequest(state, "approval-1")).toBe(true);
    expect(wireConversationSnapshot(state).requests).toEqual([]);
  });
});
