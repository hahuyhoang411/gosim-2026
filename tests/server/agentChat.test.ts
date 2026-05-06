import { describe, expect, test } from "bun:test";
import {
  appendStreamingChatText,
  resetStreamingChat,
  type StreamingChatState,
} from "../../server/agentChat.js";
import type { AgentChatEntry, AgentChatRole } from "../../server/types.js";

function makeEntryFactory(agentId: number, role: AgentChatRole, text: string): () => AgentChatEntry {
  let seq = 0;
  return () => ({
    id: `entry-${++seq}`,
    agentId,
    role,
    text,
    createdAt: 1_000 + seq,
    source: "wire",
  });
}

describe("streaming agent chat coalescing", () => {
  test("appends multiple assistant chunks into one wire chat entry", () => {
    const conversation: AgentChatEntry[] = [];
    const stream: StreamingChatState = { activeEntryId: null };

    const first = appendStreamingChatText({
      conversation,
      stream,
      role: "assistant",
      text: "Hello",
      createEntry: makeEntryFactory(7, "assistant", "Hello"),
    });
    const second = appendStreamingChatText({
      conversation,
      stream,
      role: "assistant",
      text: "!",
      createEntry: makeEntryFactory(7, "assistant", "!"),
    });
    const third = appendStreamingChatText({
      conversation,
      stream,
      role: "assistant",
      text: " How can I help?",
      createEntry: makeEntryFactory(7, "assistant", " How can I help?"),
    });

    expect(first.isUpdate).toBe(false);
    expect(second.isUpdate).toBe(true);
    expect(third.isUpdate).toBe(true);
    expect(conversation).toHaveLength(1);
    expect(conversation[0]).toMatchObject({
      id: first.entry.id,
      agentId: 7,
      role: "assistant",
      text: "Hello! How can I help?",
      source: "wire",
    });
    expect(second.entry.id).toBe(first.entry.id);
    expect(third.entry.id).toBe(first.entry.id);
  });

  test("starts a new assistant entry after the stream cursor is reset", () => {
    const conversation: AgentChatEntry[] = [];
    const stream: StreamingChatState = { activeEntryId: null };
    let seq = 0;
    const create = (role: AgentChatRole, text: string) => () => ({
      id: `entry-${++seq}`,
      agentId: 7,
      role,
      text,
      createdAt: 1_000 + seq,
      source: "wire" as const,
    });

    appendStreamingChatText({ conversation, stream, role: "assistant", text: "First", createEntry: create("assistant", "First") });
    resetStreamingChat(stream);
    appendStreamingChatText({ conversation, stream, role: "assistant", text: "Second", createEntry: create("assistant", "Second") });

    expect(conversation.map((entry) => entry.text)).toEqual(["First", "Second"]);
  });

  test("does not merge thinking chunks into the active assistant entry", () => {
    const conversation: AgentChatEntry[] = [];
    const stream: StreamingChatState = { activeEntryId: null };
    let seq = 0;
    const create = (role: AgentChatRole, text: string) => () => ({
      id: `entry-${++seq}`,
      agentId: 7,
      role,
      text,
      createdAt: 1_000 + seq,
      source: "wire" as const,
    });

    appendStreamingChatText({ conversation, stream, role: "assistant", text: "Answer", createEntry: create("assistant", "Answer") });
    appendStreamingChatText({ conversation, stream, role: "thinking", text: "internal", createEntry: create("thinking", "internal") });

    expect(conversation.map((entry) => [entry.role, entry.text])).toEqual([
      ["assistant", "Answer"],
      ["thinking", "internal"],
    ]);
  });
});
