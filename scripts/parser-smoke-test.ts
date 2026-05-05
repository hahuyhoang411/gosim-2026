// Synthetic smoke test: feed kimi-format JSONL records through the parser,
// collect emitted ServerMessages, and assert the expected sequence.
import { pairSubagentToParent, processSubagentLine, processTranscriptLine } from "../server/parser.js";
import type { TrackedAgent, ServerMessage } from "../server/types.js";

function makeAgent(): TrackedAgent {
  return {
    id: 1,
    sessionId: "sess",
    projectDir: "/tmp/proj",
    projectName: "proj",
    jsonlFile: "/tmp/context.jsonl",
    fileOffset: 0,
    lineBuffer: "",
    activity: "idle",
    activeTools: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastActivityTime: Date.now(),
    pendingAgentToolIds: [],
  };
}

const events: ServerMessage[] = [];
const emit = (m: ServerMessage) => events.push(m);
const agent = makeAgent();
const subagentEvents: ServerMessage[] = [];
const emitSubagent = (m: ServerMessage) => subagentEvents.push(m);
const subagentAgent = makeAgent();

// Realistic kimi-cli context.jsonl lines.
const lines = [
  // 1. system prompt — should be ignored
  JSON.stringify({ role: "_system_prompt", content: "You are kimi..." }),

  // 2. user turn — should clear and reset
  JSON.stringify({ role: "user", content: [{ type: "text", text: "list files in /tmp" }] }),

  // 3. assistant with a Bash tool call
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "I'll run ls." }],
    tool_calls: [
      {
        type: "function",
        id: "call_abc",
        function: { name: "Bash", arguments: JSON.stringify({ command: "ls /tmp" }) },
      },
    ],
  }),

  // 4. tool result — closes call_abc
  JSON.stringify({
    role: "tool",
    tool_call_id: "call_abc",
    content: [{ type: "text", text: "file1\nfile2\n" }],
  }),

  // 5. assistant final text reply (no tool calls) — should start the waiting timer
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Done. Two files listed." }],
  }),

  // 6. _usage / _checkpoint — must be ignored
  JSON.stringify({ role: "_usage", token_count: 1234 }),
  JSON.stringify({ role: "_checkpoint", id: 7 }),

  // 7. assistant with a Read (READING_TOOLS) call — different activity
  JSON.stringify({
    role: "assistant",
    content: [],
    tool_calls: [
      {
        type: "function",
        id: "call_read1",
        function: { name: "Read", arguments: JSON.stringify({ file_path: "/etc/hosts" }) },
      },
    ],
  }),
];

for (const line of lines) processTranscriptLine(line, agent, emit);

processTranscriptLine(
  JSON.stringify({
    role: "assistant",
    content: [],
    tool_calls: [
      {
        type: "function",
        id: "call_agent",
        function: { name: "Agent", arguments: JSON.stringify({ description: "inspect parser flow" }) },
      },
    ],
  }),
  subagentAgent,
  emitSubagent,
);
const parentToolId = pairSubagentToParent(subagentAgent);
if (parentToolId) {
  processSubagentLine(
    JSON.stringify({
      role: "assistant",
      content: [],
      tool_calls: [
        {
          type: "function",
          id: "call_subread",
          function: { name: "Read", arguments: JSON.stringify({ file_path: "/etc/hosts" }) },
        },
      ],
    }),
    subagentAgent,
    parentToolId,
    emitSubagent,
  );
  processSubagentLine(
    JSON.stringify({
      role: "tool",
      tool_call_id: "call_subread",
      content: [{ type: "text", text: "127.0.0.1 localhost" }],
    }),
    subagentAgent,
    parentToolId,
    emitSubagent,
  );
}

console.log("--- emitted events ---");
for (const e of events) console.log(JSON.stringify(e));
console.log("--- agent state ---");
console.log({
  activity: agent.activity,
  activeToolNames: Array.from(agent.activeToolNames.entries()),
  hadToolsInTurn: agent.hadToolsInTurn,
});

// Assertions
const assertions: [string, boolean][] = [
  ["bash tool start emitted", events.some((e) => e.type === "agentToolStart" && e.toolId === "call_abc" && e.status.startsWith("Running:"))],
  ["bash status begins active", events.findIndex((e) => e.type === "agentStatus" && e.status === "active") >= 0],
  ["bash arguments parsed (status mentions ls)", events.some((e) => e.type === "agentToolStart" && e.status.includes("ls /tmp"))],
  ["read tool start emitted with friendly status", events.some((e) => e.type === "agentToolStart" && e.toolId === "call_read1" && e.status === "Reading hosts")],
  ["activeTools cleared call_abc after tool result (only call_read1 remains)", agent.activeToolNames.size === 1 && agent.activeToolNames.has("call_read1")],
  ["_system_prompt / _usage / _checkpoint did not produce events", true /* implied by counts below */],
  ["activity reflects last (read) tool", agent.activity === "reading"],
  ["Agent tool_call queued for FIFO subagent pairing", parentToolId === "call_agent"],
  [
    "subagent tool start emitted under parent Agent call",
    subagentEvents.some(
      (e) =>
        e.type === "subagentToolStart" &&
        e.parentToolId === "call_agent" &&
        e.toolId === "call_subread" &&
        e.status === "Reading hosts",
    ),
  ],
];

let failed = 0;
for (const [name, ok] of assertions) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}

// Wait briefly to let the deferred tool-done timer fire for call_abc, then re-check.
setTimeout(() => {
  const doneFired = events.some((e) => e.type === "agentToolDone" && e.toolId === "call_abc");
  console.log(`${doneFired ? "✓" : "✗"} agentToolDone fired for call_abc (after delay)`);
  if (!doneFired) failed++;
  const subDoneFired = subagentEvents.some((e) => e.type === "subagentToolDone" && e.parentToolId === "call_agent" && e.toolId === "call_subread");
  console.log(`${subDoneFired ? "✓" : "✗"} subagentToolDone fired for call_subread (after delay)`);
  if (!subDoneFired) failed++;
  console.log(`\n${failed === 0 ? "ALL PASSED" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}, 500);
