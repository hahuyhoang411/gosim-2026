import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine, processSubagentLine, pairSubagentToParent } from "./parser.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import type { KimiSessionSummary, TrackedAgent, ServerMessage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 600_000; // 10 minutes
const KIMI_EXECUTABLE = process.env.KIMI_CLI || findExecutable("kimi") || "kimi";
const KIMI_DIR = join(homedir(), ".kimi");
const KIMI_SESSIONS_DIR = join(KIMI_DIR, "sessions");
const KIMI_STATE_PATH = join(KIMI_DIR, "kimi.json");

// State
const agents = new Map<string, TrackedAgent>(); // sessionId -> agent
let nextAgentId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

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

function workdirHash(path: string): string {
  return createHash("md5").update(path).digest("hex");
}

function readKimiWorkdirMap(): Map<string, string> {
  const byHash = new Map<string, string>();
  try {
    const data = JSON.parse(readFileSync(KIMI_STATE_PATH, "utf-8")) as {
      work_dirs?: Array<{ path?: string }>;
    };
    for (const entry of data.work_dirs || []) {
      if (entry.path) byHash.set(workdirHash(entry.path), entry.path);
    }
  } catch {
    /* kimi.json may not exist before the first CLI run */
  }
  return byHash;
}

function readSessionTitle(sessionDir: string, fallback: string): string {
  try {
    const statePath = join(sessionDir, "state.json");
    if (!existsSync(statePath)) return fallback;
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
      title?: string;
      custom_title?: string;
    };
    return state.title || state.custom_title || fallback;
  } catch {
    return fallback;
  }
}

function listKimiSessions(): KimiSessionSummary[] {
  const workdirs = readKimiWorkdirMap();
  if (!existsSync(KIMI_SESSIONS_DIR)) return [];

  const sessions: KimiSessionSummary[] = [];
  for (const wd of readdirSync(KIMI_SESSIONS_DIR, { withFileTypes: true })) {
    if (!wd.isDirectory()) continue;
    const workdirHashValue = wd.name;
    const workdirPath = workdirs.get(workdirHashValue);
    const workdirDir = join(KIMI_SESSIONS_DIR, workdirHashValue);
    for (const sd of readdirSync(workdirDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue;
      const sessionId = sd.name;
      const sessionDir = join(workdirDir, sessionId);
      const contextPath = join(sessionDir, "context.jsonl");
      if (!existsSync(contextPath)) continue;
      let updatedAt = 0;
      try {
        updatedAt = statSync(contextPath).mtimeMs;
      } catch {
        /* leave as 0 */
      }
      sessions.push({
        sessionId,
        workdirHash: workdirHashValue,
        workdirPath,
        title: readSessionTitle(sessionDir, sessionId.slice(0, 8)),
        updatedAt,
        active: agents.has(sessionId),
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
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

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null }> | null {
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
  ws.send(JSON.stringify({ type: "kimiSessions", sessions: listKimiSessions() }));

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
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.projectName;
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
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
}

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => { (ws as unknown as Record<string, boolean>).__isAlive = true; });
  clients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
      } else if (msg.type === "listKimiSessions") {
        ws.send(JSON.stringify({ type: "kimiSessions", sessions: listKimiSessions() }));
      } else if (msg.type === "resumeKimiSession") {
        launchKimi(msg.workdirPath, msg.sessionId);
      } else if (msg.type === "openClaude" || msg.type === "openKimi") {
        launchKimi(msg.folderPath);
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
          writeFileSync(persistedSeatsPath, JSON.stringify(msg.seats, null, 2));
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

  const agent: TrackedAgent = {
    id: nextAgentId++,
    sessionId: file.sessionId,
    projectDir: dirname(file.path),
    projectName: file.projectName,
    jsonlFile: file.path,
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

  agents.set(file.sessionId, agent);
  broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName });
  broadcast({ type: "kimiSessions", sessions: listKimiSessions() });
  console.log(`Agent ${agent.id} joined: ${agent.projectName} (${file.sessionId.slice(0, 8)})`);
});

watcher.on("fileRenamed", (file: WatchedFile) => {
  if (file.kind !== "parent") return;
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  agent.projectName = file.projectName;
  broadcast({ type: "agentRenamed", id: agent.id, folderName: file.projectName });
  broadcast({ type: "kimiSessions", sessions: listKimiSessions() });
  console.log(`Agent ${agent.id} renamed: ${file.projectName}`);
});

watcher.on("fileRemoved", (file: WatchedFile) => {
  if (file.kind === "subagent") return;
  const agent = agents.get(file.sessionId);
  if (!agent) return;

  agents.delete(file.sessionId);
  broadcast({ type: "agentClosed", id: agent.id });
  broadcast({ type: "kimiSessions", sessions: listKimiSessions() });
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
  watcher.stop();
  server.close();
  process.exit(0);
});
