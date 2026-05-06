import * as path from "path";
import type { TrackedAgent, ServerMessage } from "./types.js";

// kimi-cli context.jsonl record shapes:
//   {"role":"_system_prompt", "content":"..."}
//   {"role":"_usage", "token_count":N}
//   {"role":"_checkpoint", "id":N}
//   {"role":"user",      "content":[{"type":"text","text":"..."}]}
//   {"role":"assistant", "content":[{"type":"text",...}|{"type":"think",...}],
//                        "tool_calls":[{"type":"function","id":"call_xxx",
//                                       "function":{"name":"Bash","arguments":"{...json...}"}}]}
//   {"role":"tool",      "tool_call_id":"call_xxx", "content":[{"type":"text","text":"..."}]}

const READING_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
// kimi-cli's subagent-spawning tool is "Agent" (returns an "aXXXXXXXX" id).
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const PERMISSION_EXEMPT_TOOLS = new Set(["Agent", "Task", "AskUserQuestion"]);
const PERMISSION_TIMER_DELAY_MS = 7000;
const TEXT_IDLE_DELAY_MS = 5000;
const TOOL_DONE_DELAY_MS = 300;
const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
const IDLE_ACTIVITY_TIMEOUT_MS = 120_000;

const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const idleTimeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();

function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === "string" ? path.basename(p) : "");
  switch (toolName) {
    case "Read":
      return `Reading ${base(input.file_path)}`;
    case "Edit":
      return `Editing ${base(input.file_path)}`;
    case "Write":
      return `Writing ${base(input.file_path)}`;
    case "Bash": {
      const cmd = (input.command as string) || "";
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + "…" : cmd}`;
    }
    case "Glob":
      return "Searching files";
    case "Grep":
      return "Searching code";
    case "WebFetch":
      return "Fetching web content";
    case "WebSearch":
      return "Searching the web";
    case "Agent":
    case "Task": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + "…" : desc}`
        : "Running subtask";
    }
    case "AskUserQuestion":
      return "Waiting for your answer";
    case "EnterPlanMode":
      return "Planning";
    case "NotebookEdit":
      return "Editing notebook";
    default:
      return `Using ${toolName}`;
  }
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function cancelTimer(agentId: number, timers: Map<number, ReturnType<typeof setTimeout>>): void {
  const t = timers.get(agentId);
  if (t) {
    clearTimeout(t);
    timers.delete(agentId);
  }
}

function startWaitingTimer(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  cancelTimer(agent.id, waitingTimers);
  waitingTimers.set(
    agent.id,
    setTimeout(() => {
      waitingTimers.delete(agent.id);
      agent.isWaiting = true;
      agent.hadToolsInTurn = false;
      emit({ type: "agentStatus", id: agent.id, status: "waiting" });
    }, TEXT_IDLE_DELAY_MS),
  );
}

function startIdleTimeout(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  cancelTimer(agent.id, idleTimeoutTimers);
  idleTimeoutTimers.set(
    agent.id,
    setTimeout(() => {
      idleTimeoutTimers.delete(agent.id);
      if (agent.activity !== "idle" && agent.activity !== "waiting") {
        clearAgentActivity(agent, emit);
        agent.isWaiting = true;
        agent.hadToolsInTurn = false;
        agent.activity = "waiting";
        emit({ type: "agentStatus", id: agent.id, status: "waiting" });
      }
    }, IDLE_ACTIVITY_TIMEOUT_MS),
  );
}

function startPermissionTimer(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  cancelTimer(agent.id, permissionTimers);
  permissionTimers.set(
    agent.id,
    setTimeout(() => {
      permissionTimers.delete(agent.id);
      let hasNonExempt = false;
      for (const [, toolName] of agent.activeToolNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExempt = true;
          break;
        }
      }
      if (hasNonExempt && !agent.permissionSent) {
        agent.permissionSent = true;
        emit({ type: "agentToolPermission", id: agent.id });
      }
    }, PERMISSION_TIMER_DELAY_MS),
  );
}

export function processTranscriptLine(
  line: string,
  agent: TrackedAgent,
  emit: (msg: ServerMessage) => void,
): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }

  const role = record.role as string | undefined;
  if (!role) return;

  // Internal records (_system_prompt / _usage / _checkpoint) — ignore.
  if (role.startsWith("_")) return;

  if (role === "assistant") {
    handleAssistantMessage(record, agent, emit);
  } else if (role === "user") {
    handleUserMessage(agent, emit);
  } else if (role === "tool") {
    handleToolResult(record, agent, emit);
  }
  // role === "system" mid-session is rare in kimi-cli; skip.
}

function handleAssistantMessage(
  record: Record<string, unknown>,
  agent: TrackedAgent,
  emit: (msg: ServerMessage) => void,
): void {
  const toolCalls = Array.isArray(record.tool_calls) ? (record.tool_calls as Array<Record<string, unknown>>) : [];
  const content = Array.isArray(record.content) ? (record.content as Array<Record<string, unknown>>) : [];
  const hasText = content.some((b) => b.type === "text" || b.type === "think");

  if (toolCalls.length > 0) {
    cancelTimer(agent.id, waitingTimers);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    emit({ type: "agentStatus", id: agent.id, status: "active" });

    let hasNonExemptTool = false;
    for (const call of toolCalls) {
      const toolId = (call.id as string) || "";
      if (!toolId) continue;
      const fn = (call.function as Record<string, unknown>) || {};
      const toolName = (fn.name as string) || "";
      const input = parseToolArguments(fn.arguments);
      const status = formatToolStatus(toolName, input);

      agent.activeTools.set(toolId, { toolId, toolName, status });
      agent.activeToolNames.set(toolId, toolName);
      agent.lastActivityTime = Date.now();

      agent.activity = READING_TOOLS.has(toolName) ? "reading" : "typing";

      if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
        hasNonExemptTool = true;
      }

      if (SUBAGENT_TOOL_NAMES.has(toolName)) {
        // Queue this parent tool_call so the watcher can pair it with the next
        // subagent context.jsonl that appears under <session_dir>/subagents/.
        agent.pendingAgentToolIds.push(toolId);
        // Pre-create empty containers so subagentToolStart events have somewhere to live.
        agent.activeSubagentToolIds.set(toolId, new Set());
        agent.activeSubagentToolNames.set(toolId, new Map());
      }

      emit({ type: "agentToolStart", id: agent.id, toolId, status });
    }
    if (hasNonExemptTool) {
      agent.permissionSent = false;
      startPermissionTimer(agent, emit);
    }
    startIdleTimeout(agent, emit);
  } else if (hasText && !agent.hadToolsInTurn) {
    // Pure text reply with no prior tools this turn → trigger silence-based idle timer.
    startWaitingTimer(agent, emit);
  }
}

function handleUserMessage(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  // Real user input — new turn starts. (Tool results come through role:"tool", not here.)
  cancelTimer(agent.id, waitingTimers);
  cancelTimer(agent.id, idleTimeoutTimers);
  clearAgentActivity(agent, emit);
  agent.hadToolsInTurn = false;
}

function handleToolResult(
  record: Record<string, unknown>,
  agent: TrackedAgent,
  emit: (msg: ServerMessage) => void,
): void {
  const toolId = record.tool_call_id as string | undefined;
  if (!toolId) return;

  // If this was an Agent (subagent) tool call, clear its subagent bubble cluster.
  if (agent.activeSubagentToolIds.has(toolId)) {
    clearSubagentActivity(agent, toolId, emit);
  }
  // If the subagent never got matched (parent finished before context.jsonl appeared), drop it.
  agent.pendingAgentToolIds = agent.pendingAgentToolIds.filter((id) => id !== toolId);

  agent.activeTools.delete(toolId);
  agent.activeToolNames.delete(toolId);

  setTimeout(() => {
    emit({ type: "agentToolDone", id: agent.id, toolId });
  }, TOOL_DONE_DELAY_MS);

  if (agent.activeTools.size === 0) {
    agent.hadToolsInTurn = false;
  }
}

/**
 * Pairs an unbound subagent context.jsonl file with the next pending parent
 * Agent tool_call_id (FIFO). Returns the parentToolId or null if no pending
 * call is waiting (which can happen when an old subagent dir is detected
 * before its parent line is read on startup).
 */
export function pairSubagentToParent(agent: TrackedAgent): string | null {
  return agent.pendingAgentToolIds.shift() ?? null;
}

/**
 * Process a line from a subagent's context.jsonl. Emits subagentToolStart /
 * subagentToolDone scoped to the parent's tool_call_id.
 */
export function processSubagentLine(
  line: string,
  agent: TrackedAgent,
  parentToolId: string,
  emit: (msg: ServerMessage) => void,
): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const role = record.role as string | undefined;
  if (!role || role.startsWith("_")) return;

  if (role === "assistant") {
    const toolCalls = Array.isArray(record.tool_calls) ? (record.tool_calls as Array<Record<string, unknown>>) : [];
    if (toolCalls.length === 0) {
      const content = Array.isArray(record.content) ? (record.content as Array<Record<string, unknown>>) : [];
      const hasText = content.some((b) => b.type === "text" || b.type === "think");
      if (hasText) clearSubagentActivity(agent, parentToolId, emit);
      return;
    }

    let subTools = agent.activeSubagentToolIds.get(parentToolId);
    if (!subTools) {
      subTools = new Set();
      agent.activeSubagentToolIds.set(parentToolId, subTools);
    }
    let subNames = agent.activeSubagentToolNames.get(parentToolId);
    if (!subNames) {
      subNames = new Map();
      agent.activeSubagentToolNames.set(parentToolId, subNames);
    }

    let hasNonExempt = false;
    for (const call of toolCalls) {
      const toolId = (call.id as string) || "";
      if (!toolId) continue;
      const fn = (call.function as Record<string, unknown>) || {};
      const toolName = (fn.name as string) || "";
      const input = parseToolArguments(fn.arguments);
      const status = formatToolStatus(toolName, input);

      subTools.add(toolId);
      subNames.set(toolId, toolName);
      if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) hasNonExempt = true;

      emit({ type: "subagentToolStart", id: agent.id, parentToolId, toolId, status });
    }
    if (hasNonExempt) startPermissionTimer(agent, emit);
  } else if (role === "tool") {
    const toolId = record.tool_call_id as string | undefined;
    if (!toolId) return;
    const subTools = agent.activeSubagentToolIds.get(parentToolId);
    if (subTools) subTools.delete(toolId);
    const subNames = agent.activeSubagentToolNames.get(parentToolId);
    if (subNames) subNames.delete(toolId);

    setTimeout(() => {
      emit({ type: "subagentToolDone", id: agent.id, parentToolId, toolId });
    }, TOOL_DONE_DELAY_MS);
  }
}

function clearSubagentActivity(agent: TrackedAgent, parentToolId: string, emit: (msg: ServerMessage) => void): void {
  const hadSubagent = agent.activeSubagentToolIds.has(parentToolId)
    || agent.activeSubagentToolNames.has(parentToolId)
    || agent.pendingAgentToolIds.includes(parentToolId);
  agent.activeSubagentToolIds.delete(parentToolId);
  agent.activeSubagentToolNames.delete(parentToolId);
  agent.pendingAgentToolIds = agent.pendingAgentToolIds.filter((id) => id !== parentToolId);
  if (hadSubagent) {
    emit({ type: "subagentClear", id: agent.id, parentToolId });
  }
}

function clearAgentActivity(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  cancelTimer(agent.id, permissionTimers);
  cancelTimer(agent.id, idleTimeoutTimers);
  if (agent.activeTools.size > 0) {
    agent.activeTools.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    emit({ type: "agentToolsClear", id: agent.id });
  }
  if (agent.permissionSent) {
    agent.permissionSent = false;
    emit({ type: "agentToolPermissionClear", id: agent.id });
  }
  agent.activity = "idle";
}
