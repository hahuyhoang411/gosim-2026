import { describe, expect, test } from "bun:test";
import { upsertAgentChatEntry } from "../../webview-ui/src/hooks/agentChats.js";
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
