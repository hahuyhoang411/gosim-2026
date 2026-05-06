import { describe, expect, test } from "bun:test";
import {
  coalesceVisibleAgentChatEntries,
  upsertAgentChatEntry,
} from "../../webview-ui/src/hooks/agentChats.js";
import type { AgentChatEntry } from "../../webview-ui/src/hooks/useExtensionMessages.js";

function entry(id: string, text: string): AgentChatEntry {
  return {
    id,
    agentId: 3,
    role: "assistant",
    text,
    createdAt: 1_000,
    source: "wire",
  };
}

describe("webview agent chat entry upsert", () => {
  test("appends new entries", () => {
    expect(upsertAgentChatEntry([], entry("a", "Hello"))).toEqual([entry("a", "Hello")]);
  });

  test("replaces an existing entry with the same id", () => {
    const original = entry("a", "Hello");
    const updated = entry("a", "Hello! How can I help?");

    expect(upsertAgentChatEntry([original], updated)).toEqual([updated]);
  });

  test("preserves the position of an updated entry", () => {
    const first = entry("a", "First");
    const second = entry("b", "Second");
    const updatedFirst = entry("a", "First updated");

    expect(upsertAgentChatEntry([first, second], updatedFirst)).toEqual([updatedFirst, second]);
  });
});

describe("visible wire chat coalescing", () => {
  test("renders adjacent assistant wire chunks as one visible message even when ids differ", () => {
    const visible = coalesceVisibleAgentChatEntries([
      entry("chunk-1", "Hello"),
      entry("chunk-2", "!"),
      entry("chunk-3", " I'm Kimi"),
    ]);

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      id: "chunk-1..chunk-3",
      role: "assistant",
      text: "Hello! I'm Kimi",
      source: "wire",
    });
  });

  test("does not merge assistant chunks across a user message", () => {
    const user: AgentChatEntry = {
      ...entry("user-1", "hello"),
      role: "user",
    };

    const visible = coalesceVisibleAgentChatEntries([
      entry("assistant-1", "First"),
      user,
      entry("assistant-2", "Second"),
    ]);

    expect(visible.map((item) => [item.role, item.text])).toEqual([
      ["assistant", "First"],
      ["user", "hello"],
      ["assistant", "Second"],
    ]);
  });
});
