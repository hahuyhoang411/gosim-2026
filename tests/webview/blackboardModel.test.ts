import { describe, expect, test } from "bun:test";
import {
  buildBlackboardSections,
  normalizeAgentTodos,
  summarizeTodos,
} from "../../webview-ui/src/components/blackboardModel.js";

describe("blackboard model", () => {
  test("builds sections only for agents with TODOs in current agent order", () => {
    const sections = buildBlackboardSections([3, 1, 2], {
      1: [{ title: "Brainstorm roles", status: "done" }],
      2: [],
      3: [{ title: "Search outside sources", status: "in_progress" }],
    });

    expect(sections.map((section) => section.agentId)).toEqual([3, 1]);
    expect(sections[0].summary).toEqual({ total: 1, done: 0, inProgress: 1, pending: 0 });
  });

  test("summarizes TODO statuses for the board header", () => {
    expect(
      summarizeTodos([
        { title: "Done", status: "done" },
        { title: "Doing", status: "in_progress" },
        { title: "Todo A", status: "pending" },
        { title: "Todo B", status: "pending" },
      ]),
    ).toEqual({ total: 4, done: 1, inProgress: 1, pending: 2 });
  });

  test("normalizes incoming TODO payloads from WebSocket messages", () => {
    expect(
      normalizeAgentTodos([
        { title: "  Render blackboard  ", status: "in_progress" },
        { title: "", status: "done" },
        { title: "Fallback status", status: "blocked" },
      ]),
    ).toEqual([
      { title: "Render blackboard", status: "in_progress" },
      { title: "Fallback status", status: "pending" },
    ]);
  });

  test("returns an empty board when no agent has TODOs", () => {
    expect(buildBlackboardSections([1, 2], { 1: [], 2: [] })).toEqual([]);
  });
});
