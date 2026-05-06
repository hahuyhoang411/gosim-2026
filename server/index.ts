import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname, basename } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine, processSubagentLine, pairSubagentToParent } from "./parser.js";
import { listKimiSessions } from "./kimiMetadata.js";
import {
  KimiWireSession,
  contentInputText,
  contentPartText,
  formatWireToolStatus,
  requestDisplayText,
  type WireEventParams,
  type WireRequestEnvelope,
} from "./kimiWire.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import type {
  AgentChatEntry,
  AgentBubbleKind,
  AgentChatRole,
  AgentProcessState,
  AgentTurnState,
  ClientMessage,
  ServerMessage,
  TrackedAgent,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 600_000; // 10 minutes
const KIMI_EXECUTABLE = process.env.KIMI_CLI || findExecutable("kimi") || "kimi";

// State
const agents = new Map<string, TrackedAgent>(); // sessionId -> agent
const agentKeysById = new Map<number, string>();
let nextAgentId = 1;
let nextChatEntryId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

interface PendingWireRequest {
  rpcId: string;
  requestId: string;
  requestType: string;
  payload: Record<string, unknown>;
}

interface UiWireAgent {
  key: string;
  agent: TrackedAgent;
  wire: KimiWireSession;
  conversation: AgentChatEntry[];
  pendingRequests: Map<string, PendingWireRequest>;
  turnState: AgentTurnState;
  processState: AgentProcessState;
  runningPrompt: Promise<unknown> | null;
}

const wireAgents = new Map<number, UiWireAgent>();

function findExecutable(name: string): string | null {
  const pathDirs = (process.env.PATH || "").split(":").filter(Boolean);
  const extraDirs = [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const dir of [...pathDirs, ...extraDirs]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function currentKimiSessions(): ReturnType<typeof listKimiSessions> {
  return listKimiSessions(new Set([...agents.keys()].filter((key) => !key.startsWith("wire:"))), 48);
}

function resolveLaunchCwd(folderPath: unknown): string {
  const candidate = typeof folderPath === "string" && folderPath.trim()
    ? folderPath
    : process.env.PROJECT_ROOT || process.cwd();
  try {
    if (statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* fall back below */
  }
  return process.cwd();
}

function createTrackedAgent(id: number, sessionId: string, projectDir: string, projectName: string, jsonlFile = ""): TrackedAgent {
  return {
    id,
    sessionId,
    projectDir,
    projectName,
    jsonlFile,
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

function projectNameFromPath(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized || "Kimi Agent";
}

function workdirHash(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

function fileWorkdirHash(contextPath: string): string {
  return basename(dirname(dirname(contextPath)));
}

function adoptWatcherFileForWireAgent(file: WatchedFile): boolean {
  if (file.kind !== "parent") return false;
  const hash = fileWorkdirHash(file.path);
  const candidates = [...wireAgents.values()]
    .filter((ui) => ui.agent.jsonlFile === "" && workdirHash(ui.agent.projectDir) === hash)
    .sort((a, b) => b.agent.lastActivityTime - a.agent.lastActivityTime);
  const match = candidates[0];
  if (!match) return false;

  agents.delete(match.key);
  match.key = file.sessionId;
  match.agent.sessionId = file.sessionId;
  match.agent.jsonlFile = file.path;
  match.agent.projectName = projectNameFromPath(match.agent.projectDir);
  rememberAgent(file.sessionId, match.agent);
  broadcast({ type: "kimiSessions", sessions: currentKimiSessions() });
  console.log(`Agent ${match.agent.id} bound to Kimi session ${file.sessionId.slice(0, 8)}`);
  return true;
}

function rememberAgent(key: string, agent: TrackedAgent): void {
  agents.set(key, agent);
  agentKeysById.set(agent.id, key);
}

function forgetAgentById(id: number): TrackedAgent | null {
  const key = agentKeysById.get(id);
  if (!key) return null;
  const agent = agents.get(key) ?? null;
  agents.delete(key);
  agentKeysById.delete(id);
  return agent;
}

function setWireTurnState(ui: UiWireAgent, turnState: AgentTurnState): void {
  ui.turnState = turnState;
  broadcast({ type: "agentTurnState", agentId: ui.agent.id, turnState });
}

function setWireProcessState(ui: UiWireAgent, state: AgentProcessState, error?: string): void {
  ui.processState = state;
  broadcast({ type: "agentProcessState", agentId: ui.agent.id, state, pid: ui.wire.pid, error });
}

function appendWireChat(
  ui: UiWireAgent,
  role: AgentChatRole,
  text: string,
  source: AgentChatEntry["source"] = "wire",
): AgentChatEntry {
  const entry: AgentChatEntry = {
    id: `${Date.now()}-${nextChatEntryId++}`,
    agentId: ui.agent.id,
    role,
    text,
    createdAt: Date.now(),
    source,
  };
  ui.conversation.push(entry);
  broadcast({ type: "agentChatEntry", agentId: ui.agent.id, entry });
  return entry;
}

function emitWireBubble(ui: UiWireAgent, text: string, kind: AgentBubbleKind, ttlMs?: number): void {
  broadcast({ type: "agentBubble", agentId: ui.agent.id, text, kind, ttlMs });
}

function launchKimi(folderPath: unknown, sessionId?: string): void {
  const cwd = resolveLaunchCwd(folderPath);
  const modeArgs = sessionId
    ? `--work-dir ${shellQuote(cwd)} --session ${shellQuote(sessionId)}`
    : `--work-dir ${shellQuote(cwd)} --continue`;
  const command = `${shellQuote(KIMI_EXECUTABLE)} ${modeArgs}`;

  if (platform() === "darwin") {
    const child = spawn(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script ${appleScriptString(command)}`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    console.log(`[Server] Opening Kimi CLI in Terminal at ${cwd}${sessionId ? ` (${sessionId})` : ""}`);
    return;
  }

  const terminal = findExecutable("x-terminal-emulator")
    || findExecutable("gnome-terminal")
    || findExecutable("konsole")
    || findExecutable("xterm");
  if (terminal) {
    const base = terminal.split("/").pop() || terminal;
    const args = base === "gnome-terminal"
      ? ["--", "sh", "-lc", command]
      : base === "konsole"
        ? ["-e", "sh", "-lc", command]
        : ["-e", "sh", "-lc", command];
    const child = spawn(terminal, args, { detached: true, stdio: "ignore" });
    child.unref();
    console.log(`[Server] Opening Kimi CLI in ${base} at ${cwd}${sessionId ? ` (${sessionId})` : ""}`);
    return;
  }

  const args = sessionId
    ? ["--work-dir", cwd, "--session", sessionId]
    : ["--work-dir", cwd, "--continue"];
  const child = spawn(KIMI_EXECUTABLE, args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
  console.log(`[Server] Started Kimi CLI without a terminal at ${cwd}${sessionId ? ` (${sessionId})` : ""}`);
}

function spawnUiKimiAgent(msg: Extract<ClientMessage, { type: "spawnKimiAgent" }>): void {
  const cwd = resolveLaunchCwd(msg.workdirPath);
  const id = nextAgentId++;
  const key = `wire:${id}`;
  const agent = createTrackedAgent(id, key, cwd, projectNameFromPath(cwd));
  rememberAgent(key, agent);

  const wire = new KimiWireSession({ executable: KIMI_EXECUTABLE, cwd, yolo: Boolean(msg.yolo) });
  const ui: UiWireAgent = {
    key,
    agent,
    wire,
    conversation: [],
    pendingRequests: new Map(),
    turnState: "idle",
    processState: "starting",
    runningPrompt: null,
  };
  wireAgents.set(id, ui);
  bindWireAgent(ui);

  lastActivityTime = Date.now();
  broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName });
  setWireProcessState(ui, "starting");
  broadcast({ type: "kimiSessions", sessions: currentKimiSessions() });

  void (async () => {
    try {
      await wire.initialize();
      setWireProcessState(ui, "ready");
      setWireTurnState(ui, "idle");
      if (msg.planMode) {
        try {
          await wire.setPlanMode(true);
        } catch (err) {
          appendWireChat(ui, "system", `Plan mode unavailable: ${err instanceof Error ? err.message : String(err)}`, "system");
        }
      }
      const initialPrompt = typeof msg.prompt === "string" ? msg.prompt.trim() : "";
      if (initialPrompt) {
        await sendWireAgentMessage(id, initialPrompt);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWireProcessState(ui, "crashed", message);
      setWireTurnState(ui, "error");
      appendWireChat(ui, "system", message, "system");
      emitWireBubble(ui, message, "error", 8_000);
    }
  })();
}

function bindWireAgent(ui: UiWireAgent): void {
  ui.wire.on("wireEvent", (event: WireEventParams) => handleWireEvent(ui, event));
  ui.wire.on("wireRequest", (request: WireRequestEnvelope) => handleWireRequest(ui, request));
  ui.wire.on("stderr", (chunk: string) => {
    const text = chunk.replace(/\s+/g, " ").trim();
    if (text && /\b(error|failed|traceback|panic)\b/i.test(text)) {
      appendWireChat(ui, "system", text, "system");
    }
  });
  ui.wire.on("protocolError", (err: Error) => {
    appendWireChat(ui, "system", err.message, "system");
  });
  ui.wire.on("exit", ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
    const expected = ui.processState === "exited";
    const state: AgentProcessState = expected || code === 0 ? "exited" : "crashed";
    const detail = `Kimi process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
    setWireProcessState(ui, state, state === "crashed" ? detail : undefined);
    setWireTurnState(ui, state === "crashed" ? "error" : "idle");
    if (state === "crashed") {
      appendWireChat(ui, "system", detail, "system");
      emitWireBubble(ui, detail, "error", 8_000);
    }
  });
  ui.wire.on("error", (err: Error) => {
    setWireProcessState(ui, "crashed", err.message);
    setWireTurnState(ui, "error");
    appendWireChat(ui, "system", err.message, "system");
    emitWireBubble(ui, err.message, "error", 8_000);
  });
}

async function sendWireAgentMessage(agentId: number, rawText: string): Promise<void> {
  const ui = wireAgents.get(agentId);
  if (!ui) return;
  const text = rawText.trim();
  if (!text) return;
  lastActivityTime = Date.now();

  if (ui.turnState === "waiting_for_approval" || ui.turnState === "waiting_for_answer") {
    appendWireChat(ui, "system", "Respond to the pending request above before sending more messages.", "system");
    return;
  }

  const isRunning = ui.turnState === "running";
  appendWireChat(ui, "user", text, isRunning ? "steer" : "prompt");
  emitWireBubble(ui, text, isRunning ? "steer" : "user", 4_000);

  if (ui.processState !== "ready") {
    const message = "Kimi is not ready yet.";
    appendWireChat(ui, "system", message, "system");
    emitWireBubble(ui, message, "error", 5_000);
    return;
  }

  if (isRunning) {
    try {
      await ui.wire.steer(text);
      appendWireChat(ui, "system", "Intervention injected into the running turn.", "steer");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendWireChat(ui, "system", message, "system");
      emitWireBubble(ui, message, "error", 6_000);
    }
    return;
  }

  setWireTurnState(ui, "running");
  ui.agent.lastActivityTime = Date.now();
  const promptRun = ui.wire.prompt(text);
  ui.runningPrompt = promptRun;
  try {
    const result = await promptRun as { status?: string; steps?: number } | undefined;
    if (ui.runningPrompt !== promptRun) return;
    ui.runningPrompt = null;
    const status = result?.status ?? "finished";
    if (status === "cancelled") {
      setWireTurnState(ui, "cancelled");
      appendWireChat(ui, "system", "Turn cancelled.", "system");
    } else if (status === "max_steps_reached") {
      setWireTurnState(ui, "idle");
      appendWireChat(ui, "system", `Turn stopped after ${result?.steps ?? "max"} steps.`, "system");
    } else {
      setWireTurnState(ui, "idle");
    }
    clearWireTools(ui);
  } catch (err) {
    if (ui.runningPrompt === promptRun) ui.runningPrompt = null;
    const message = err instanceof Error ? err.message : String(err);
    setWireTurnState(ui, "error");
    appendWireChat(ui, "system", message, "system");
    emitWireBubble(ui, message, "error", 8_000);
    clearWireTools(ui);
  }
}

async function cancelWireAgentTurn(agentId: number): Promise<void> {
  const ui = wireAgents.get(agentId);
  if (!ui) return;
  try {
    await ui.wire.cancel();
    setWireTurnState(ui, "cancelled");
    appendWireChat(ui, "system", "Cancel requested.", "system");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendWireChat(ui, "system", message, "system");
    if (/No agent turn is in progress/i.test(message)) {
      setWireTurnState(ui, "idle");
    } else {
      emitWireBubble(ui, message, "error", 6_000);
    }
  }
}

function closeAgent(id: number): void {
  const ui = wireAgents.get(id);
  if (ui) {
    ui.processState = "exited";
    ui.wire.removeAllListeners();
    ui.wire.dispose();
    wireAgents.delete(id);
  }
  const agent = forgetAgentById(id);
  if (!agent) return;
  broadcast({ type: "agentClosed", id: agent.id });
  broadcast({ type: "kimiSessions", sessions: currentKimiSessions() });
}

function handleWireEvent(ui: UiWireAgent, event: WireEventParams): void {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  switch (event.type) {
    case "TurnBegin":
      setWireTurnState(ui, "running");
      break;
    case "TurnEnd":
      setWireTurnState(ui, "idle");
      clearWireTools(ui);
      break;
    case "StepBegin":
      setWireTurnState(ui, "running");
      break;
    case "StepInterrupted":
      appendWireChat(ui, "system", "Step interrupted.", "system");
      break;
    case "ContentPart": {
      const part = contentPartText(payload);
      if (!part || !part.text.trim()) return;
      appendWireChat(ui, part.role, part.text, "wire");
      if (part.role === "assistant") {
        emitWireBubble(ui, part.text, "assistant", 9_000);
      }
      break;
    }
    case "ToolCall": {
      const tool = formatWireToolStatus(payload);
      if (!tool) return;
      const isKnownTool = ui.agent.activeTools.has(tool.toolId) || ui.agent.activeSubagentToolIds.has(tool.toolId);
      ui.agent.activeTools.set(tool.toolId, { toolId: tool.toolId, toolName: tool.toolName, status: tool.status });
      ui.agent.activeToolNames.set(tool.toolId, tool.toolName);
      ui.agent.lastActivityTime = Date.now();
      // Mirror parser.ts: queue Agent/Task tool ids so the file watcher can pair the eventual
      // subagents/<aid>/context.jsonl back to this parent invocation.
      if ((tool.toolName === "Agent" || tool.toolName === "Task") && !isKnownTool) {
        ui.agent.pendingAgentToolIds.push(tool.toolId);
        ui.agent.activeSubagentToolIds.set(tool.toolId, new Set());
        ui.agent.activeSubagentToolNames.set(tool.toolId, new Map());
      }
      broadcast({ type: "agentToolStart", id: ui.agent.id, toolId: tool.toolId, status: tool.status });
      break;
    }
    case "ToolResult": {
      const toolId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : "";
      if (!toolId) return;
      // Agent/Task in kimi-cli is a background dispatch: ToolResult fires within
      // ms of the call with status: "starting" while the actual subagent keeps
      // running in subagents/<aid>/. Do NOT clear the subagent character here —
      // the watcher's fileRemoved handler tears it down when the subagent file
      // goes stale.
      ui.agent.activeTools.delete(toolId);
      ui.agent.activeToolNames.delete(toolId);
      broadcast({ type: "agentToolDone", id: ui.agent.id, toolId });
      break;
    }
    case "ApprovalResponse": {
      const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
      if (requestId) {
        ui.pendingRequests.delete(requestId);
        broadcast({ type: "agentRequestResolved", agentId: ui.agent.id, requestId });
      }
      break;
    }
    case "SteerInput": {
      const text = contentInputText(payload.user_input);
      if (text) appendWireChat(ui, "system", `Steer accepted: ${text}`, "steer");
      break;
    }
    case "PlanDisplay": {
      const content = typeof payload.content === "string" ? payload.content : "";
      const filePath = typeof payload.file_path === "string" ? payload.file_path : "";
      if (content) appendWireChat(ui, "assistant", `${filePath ? `Plan: ${filePath}\n\n` : ""}${content}`, "wire");
      break;
    }
    case "BtwEnd": {
      const response = typeof payload.response === "string" ? payload.response : "";
      const error = typeof payload.error === "string" ? payload.error : "";
      if (response) appendWireChat(ui, "assistant", response, "wire");
      if (error) appendWireChat(ui, "system", error, "system");
      break;
    }
    default:
      break;
  }
}

function handleWireRequest(ui: UiWireAgent, request: WireRequestEnvelope): void {
  const payload = request.params.payload && typeof request.params.payload === "object"
    ? request.params.payload as Record<string, unknown>
    : {};
  const requestType = request.params.type || "Request";
  const requestId = typeof payload.id === "string" ? payload.id : request.rpcId;

  if (requestType === "ToolCallRequest") {
    const toolCallId = typeof payload.id === "string" ? payload.id : request.rpcId;
    ui.wire.respond(request.rpcId, {
      tool_call_id: toolCallId,
      return_value: {
        is_error: true,
        output: "External tool calls are not implemented in Pixel Agents yet.",
        message: "External tool calls are not implemented in Pixel Agents yet.",
        display: [],
      },
    });
    return;
  }
  if (requestType === "HookRequest") {
    ui.wire.respond(request.rpcId, {
      request_id: requestId,
      action: "allow",
      reason: "",
    });
    return;
  }

  ui.pendingRequests.set(requestId, {
    rpcId: request.rpcId,
    requestId,
    requestType,
    payload,
  });
  broadcast({ type: "agentRequest", agentId: ui.agent.id, request: { requestId, requestType, payload } });
  const displayText = requestDisplayText({ type: requestType, payload });
  appendWireChat(ui, "system", displayText, "request");

  if (requestType === "ApprovalRequest") {
    setWireTurnState(ui, "waiting_for_approval");
    broadcast({ type: "agentToolPermission", id: ui.agent.id });
    emitWireBubble(ui, displayText, "system", 10_000);
  } else if (requestType === "QuestionRequest") {
    setWireTurnState(ui, "waiting_for_answer");
    emitWireBubble(ui, displayText, "system", 10_000);
  }
}

function respondToWireApproval(
  msg: Extract<ClientMessage, { type: "respondApproval" }>,
): void {
  const ui = wireAgents.get(msg.agentId);
  const pending = ui?.pendingRequests.get(msg.requestId);
  if (!ui || !pending) return;
  const result: Record<string, unknown> = {
    request_id: msg.requestId,
    response: msg.response,
  };
  if (msg.feedback) result.feedback = msg.feedback;
  ui.wire.respond(pending.rpcId, result);
  ui.pendingRequests.delete(msg.requestId);
  broadcast({ type: "agentRequestResolved", agentId: ui.agent.id, requestId: msg.requestId });
  broadcast({ type: "agentToolPermissionClear", id: ui.agent.id });
  setWireTurnState(ui, "running");
}

function respondToWireQuestion(
  msg: Extract<ClientMessage, { type: "respondQuestion" }>,
): void {
  const ui = wireAgents.get(msg.agentId);
  const pending = ui?.pendingRequests.get(msg.requestId);
  if (!ui || !pending) return;
  ui.wire.respond(pending.rpcId, {
    request_id: msg.requestId,
    answers: msg.answers,
  });
  ui.pendingRequests.delete(msg.requestId);
  broadcast({ type: "agentRequestResolved", agentId: ui.agent.id, requestId: msg.requestId });
  setWireTurnState(ui, "running");
}

function clearWireTools(ui: UiWireAgent): void {
  if (ui.agent.activeTools.size === 0) return;
  ui.agent.activeTools.clear();
  ui.agent.activeToolNames.clear();
  broadcast({ type: "agentToolsClear", id: ui.agent.id, preserveSubagents: true });
}

// Load assets at startup
// In dev mode (tsx), __dirname is server/ so assets are at ../webview-ui/public/assets/
// In production (esbuild), __dirname is dist/ so assets are at ./public/assets/
const devAssetsRoot = join(__dirname, "..", "webview-ui", "public", "assets");
const prodAssetsRoot = join(__dirname, "public", "assets");
const assetsRoot = existsSync(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;

console.log(`[Server] Loading assets from: ${assetsRoot}`);

const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);

// Persistence directory
const persistDir = join(homedir(), ".pixel-agents");
const persistedLayoutPath = join(persistDir, "layout.json");
const persistedSeatsPath = join(persistDir, "agent-seats.json");

// Load layout: persisted first, then default
function loadLayout(): Record<string, unknown> | null {
  if (existsSync(persistedLayoutPath)) {
    try {
      const content = readFileSync(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content) as Record<string, unknown>;
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null; name?: string }> | null {
  if (existsSync(persistedSeatsPath)) {
    try {
      const content = readFileSync(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

let currentLayout = loadLayout();
const persistedSeats = loadPersistedSeats();

// Express app
const app = express();
// Serve production build
app.use(express.static(join(__dirname, "public")));

const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server });

// Ping/pong heartbeat — keeps clients Set accurate for shutdown guard
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of clients) {
    if ((ws as unknown as Record<string, boolean>).__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    (ws as unknown as Record<string, boolean>).__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendInitialData(ws: WebSocket): void {
  // Send settings
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));
  ws.send(JSON.stringify({ type: "kimiSessions", sessions: currentKimiSessions() }));

  // Send character sprites
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }

  // Send wall tiles
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }

  // Send floor tiles (optional)
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }

  // Send furniture assets (optional)
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites,
      }),
    );
  }

  // Send existing agents with persisted seat metadata
  const agentList = Array.from(agents.values());
  const agentIds = agentList.map((a) => a.id);
  const folderNames: Record<number, string> = {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string; name?: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.projectName;
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined, name: s.name };
    }
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, agentMeta }));

  // Send layout (must come after existingAgents — the hook buffers agents until layout arrives)
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    // Send null layout to trigger default layout creation in the UI
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }

  for (const ui of wireAgents.values()) {
    ws.send(JSON.stringify({ type: "agentProcessState", agentId: ui.agent.id, state: ui.processState, pid: ui.wire.pid }));
    ws.send(JSON.stringify({ type: "agentTurnState", agentId: ui.agent.id, turnState: ui.turnState }));
    for (const entry of ui.conversation) {
      ws.send(JSON.stringify({ type: "agentChatEntry", agentId: ui.agent.id, entry }));
    }
    for (const pending of ui.pendingRequests.values()) {
      ws.send(JSON.stringify({
        type: "agentRequest",
        agentId: ui.agent.id,
        request: {
          requestId: pending.requestId,
          requestType: pending.requestType,
          payload: pending.payload,
        },
      }));
    }
  }
}

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => { (ws as unknown as Record<string, boolean>).__isAlive = true; });
  clients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
      } else if (msg.type === "listKimiSessions") {
        ws.send(JSON.stringify({ type: "kimiSessions", sessions: currentKimiSessions() }));
      } else if (msg.type === "resumeKimiSession") {
        launchKimi(msg.workdirPath, msg.sessionId);
      } else if (msg.type === "openClaude" || msg.type === "openKimi") {
        launchKimi(msg.folderPath);
      } else if (msg.type === "spawnKimiAgent") {
        spawnUiKimiAgent(msg);
      } else if (msg.type === "sendAgentMessage") {
        void sendWireAgentMessage(msg.agentId, msg.text);
      } else if (msg.type === "cancelAgentTurn") {
        void cancelWireAgentTurn(msg.agentId);
      } else if (msg.type === "respondApproval") {
        respondToWireApproval(msg);
      } else if (msg.type === "respondQuestion") {
        respondToWireQuestion(msg);
      } else if (msg.type === "closeAgent") {
        closeAgent(msg.id);
      } else if (msg.type === "saveLayout") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedLayoutPath, JSON.stringify(msg.layout, null, 2));
          currentLayout = msg.layout as Record<string, unknown>;
          // Broadcast to other clients for multi-tab sync
          const data = JSON.stringify({ type: "layoutLoaded", layout: msg.layout, version: 1 });
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        } catch (err) {
          console.error(`[Server] Failed to save layout: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "saveAgentSeats") {
        try {
          mkdirSync(persistDir, { recursive: true });
          const previous = loadPersistedSeats() ?? {};
          const seats = msg.seats;
          for (const [id, seat] of Object.entries(seats)) {
            if (!seat.name) {
              const prevName = previous[Number(id)]?.name;
              if (prevName) seat.name = prevName;
            }
          }
          writeFileSync(persistedSeatsPath, JSON.stringify(seats, null, 2));
        } catch (err) {
          console.error(`[Server] Failed to save agent seats: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
      /* ignore invalid messages */
    }
  });

  ws.on("close", () => clients.delete(ws));
});

// Watcher
const watcher = new JsonlWatcher();

// Pair subagent files to a parent agent at file-add time. Stored on the file itself.
function bindSubagentFile(file: WatchedFile): void {
  if (file.kind !== "subagent" || file.parentToolId) return;
  const parentAgent = agents.get(file.sessionId);
  if (!parentAgent) return;
  const parentToolId = pairSubagentToParent(parentAgent);
  if (parentToolId) {
    file.parentToolId = parentToolId;
  }
}

watcher.on("fileAdded", (file: WatchedFile) => {
  lastActivityTime = Date.now();

  if (file.kind === "subagent") {
    bindSubagentFile(file);
    return;
  }

  if (agents.has(file.sessionId)) return;
  if (adoptWatcherFileForWireAgent(file)) return;

  const agent = createTrackedAgent(nextAgentId++, file.sessionId, dirname(file.path), file.projectName, file.path);
  rememberAgent(file.sessionId, agent);
  broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName });
  broadcast({ type: "kimiSessions", sessions: currentKimiSessions() });
  console.log(`Agent ${agent.id} joined: ${agent.projectName} (${file.sessionId.slice(0, 8)})`);
});

watcher.on("fileRenamed", (file: WatchedFile) => {
  if (file.kind !== "parent") return;
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  agent.projectName = file.projectName;
  broadcast({ type: "agentRenamed", id: agent.id, folderName: file.projectName });
  broadcast({ type: "kimiSessions", sessions: currentKimiSessions() });
  console.log(`Agent ${agent.id} renamed: ${file.projectName}`);
});

watcher.on("fileRemoved", (file: WatchedFile) => {
  if (file.kind === "subagent") {
    // Subagent's context.jsonl went stale (~10 min idle) → tear the character down.
    if (file.parentToolId) {
      const parentAgent = agents.get(file.sessionId);
      if (parentAgent) {
        const shouldNotify = parentAgent.activeSubagentToolIds.has(file.parentToolId)
          || parentAgent.activeSubagentToolNames.has(file.parentToolId)
          || parentAgent.pendingAgentToolIds.includes(file.parentToolId);
        parentAgent.activeSubagentToolIds.delete(file.parentToolId);
        parentAgent.activeSubagentToolNames.delete(file.parentToolId);
        parentAgent.pendingAgentToolIds = parentAgent.pendingAgentToolIds.filter((id) => id !== file.parentToolId);
        if (shouldNotify) {
          broadcast({ type: "subagentClear", id: parentAgent.id, parentToolId: file.parentToolId });
        }
      }
    }
    return;
  }
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  if (wireAgents.has(agent.id)) return;

  agents.delete(file.sessionId);
  agentKeysById.delete(agent.id);
  broadcast({ type: "agentClosed", id: agent.id });
  broadcast({ type: "kimiSessions", sessions: currentKimiSessions() });
  console.log(`Agent ${agent.id} left: ${agent.projectName}`);
});

watcher.on("line", (file: WatchedFile, line: string) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  lastActivityTime = Date.now();

  if (file.kind === "subagent") {
    if (!file.parentToolId) bindSubagentFile(file);
    if (!file.parentToolId) return;
    processSubagentLine(line, agent, file.parentToolId, broadcast);
    return;
  }

  // Wire-managed agents get their parent transcript through JSON-RPC events instead.
  if (wireAgents.has(agent.id)) return;
  processTranscriptLine(line, agent, broadcast);
});

// Start
watcher.start();
server.listen(PORT, () => {
  console.log(`Pixel Agents server running at http://localhost:${PORT}`);
  console.log(`Watching ~/.kimi/sessions/ for active kimi-cli sessions...`);
});

// Idle shutdown
setInterval(() => {
  if (agents.size === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
    console.log("No active sessions or clients for 10 minutes, shutting down...");
    watcher.stop();
    server.close();
    process.exit(0);
  }
}, 30_000);

// Graceful shutdown
process.on("SIGINT", () => {
  for (const ui of wireAgents.values()) {
    ui.wire.dispose();
  }
  watcher.stop();
  server.close();
  process.exit(0);
});
