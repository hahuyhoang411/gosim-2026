// Agent activity states
export type AgentActivity = "idle" | "typing" | "reading" | "waiting" | "permission";

export interface KimiSessionSummary {
  sessionId: string;
  workdirHash: string;
  workdirPath?: string;
  title: string;
  updatedAt: number;
  active: boolean;
}

// Tool info for speech bubbles
export interface ActiveTool {
  toolId: string;
  toolName: string;
  status: string;
}

// Agent as tracked by the server
export interface TrackedAgent {
  id: number;
  sessionId: string;
  projectDir: string;
  projectName: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activity: AgentActivity;
  activeTools: Map<string, ActiveTool>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>;
  activeSubagentToolNames: Map<string, Map<string, string>>;
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  lastActivityTime: number;
  // FIFO queue of parent "Agent" tool_call_ids awaiting subagent context.jsonl detection.
  pendingAgentToolIds: string[];
}

export type AgentChatRole = "user" | "assistant" | "thinking" | "system" | "tool";
export type AgentTurnState = "idle" | "running" | "waiting_for_approval" | "waiting_for_answer" | "cancelled" | "error";
export type AgentProcessState = "starting" | "ready" | "exited" | "crashed";
export type AgentBubbleKind = "user" | "assistant" | "system" | "steer" | "error";
export type AgentTodoStatus = "pending" | "in_progress" | "done";

export interface AgentTodoItem {
  title: string;
  status: AgentTodoStatus;
}

export interface AgentChatEntry {
  id: string;
  agentId: number;
  role: AgentChatRole;
  text: string;
  createdAt: number;
  source?: "prompt" | "steer" | "wire" | "system" | "request";
  turnId?: string;
}

export interface AgentRequestMessage {
  requestId: string;
  requestType: "ApprovalRequest" | "QuestionRequest" | "ToolCallRequest" | "HookRequest" | string;
  payload: Record<string, unknown>;
}

// Messages sent from server to client via WebSocket
// Must match the upstream message format expected by useExtensionMessages
export type ServerMessage =
  | { type: "agentCreated"; id: number; folderName: string }
  | { type: "agentRenamed"; id: number; folderName: string }
  | { type: "agentClosed"; id: number }
  | { type: "existingAgents"; agents: number[]; folderNames: Record<number, string>; agentMeta?: Record<number, { palette?: number; hueShift?: number; seatId?: string }> }
  | { type: "agentToolStart"; id: number; toolId: string; status: string }
  | { type: "agentToolDone"; id: number; toolId: string }
  | { type: "agentToolsClear"; id: number }
  | { type: "agentStatus"; id: number; status: string }
  | { type: "agentChatEntry"; agentId: number; entry: AgentChatEntry }
  | { type: "agentBubble"; agentId: number; text: string; kind: AgentBubbleKind; ttlMs?: number }
  | { type: "agentTurnState"; agentId: number; turnState: AgentTurnState }
  | { type: "agentProcessState"; agentId: number; state: AgentProcessState; pid?: number; error?: string }
  | { type: "agentRequest"; agentId: number; request: AgentRequestMessage }
  | { type: "agentRequestResolved"; agentId: number; requestId: string }
  | { type: "agentTodoList"; agentId: number; todos: AgentTodoItem[] }
  | { type: "agentToolPermission"; id: number }
  | { type: "agentToolPermissionClear"; id: number }
  | { type: "subagentToolStart"; id: number; parentToolId: string; toolId: string; status: string }
  | { type: "subagentToolDone"; id: number; parentToolId: string; toolId: string }
  | { type: "subagentToolPermission"; id: number; parentToolId: string }
  | { type: "subagentClear"; id: number; parentToolId: string }
  | { type: "characterSpritesLoaded"; characters: unknown[] }
  | { type: "floorTilesLoaded"; sprites: unknown[] }
  | { type: "wallTilesLoaded"; sprites: unknown[] }
  | { type: "furnitureAssetsLoaded"; catalog: unknown[]; sprites: Record<string, unknown> }
  | { type: "layoutLoaded"; layout: unknown; version: number }
  | { type: "kimiSessions"; sessions: KimiSessionSummary[] }
  | { type: "settingsLoaded"; soundEnabled: boolean };

// Messages sent from client to server
export type ClientMessage =
  | { type: "ready" }
  | { type: "webviewReady" }
  | { type: "openClaude"; folderPath?: string }
  | { type: "openKimi"; folderPath?: string }
  | { type: "spawnKimiAgent"; workdirPath?: string; prompt?: string; planMode?: boolean; yolo?: boolean }
  | { type: "sendAgentMessage"; agentId: number; text: string }
  | { type: "cancelAgentTurn"; agentId: number }
  | { type: "respondApproval"; agentId: number; requestId: string; response: "approve" | "approve_for_session" | "reject"; feedback?: string }
  | { type: "respondQuestion"; agentId: number; requestId: string; answers: Record<string, string> }
  | { type: "closeAgent"; id: number }
  | { type: "listKimiSessions" }
  | { type: "resumeKimiSession"; sessionId: string; workdirPath?: string }
  | { type: "focusAgent"; id: number }
  | { type: "saveLayout"; layout: unknown }
  | { type: "saveAgentSeats"; seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> };
