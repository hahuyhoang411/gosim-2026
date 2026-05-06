import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { AgentTodoItem, AgentTodoStatus } from "./types.js";

export interface KimiWireOptions {
  executable: string;
  cwd: string;
  yolo?: boolean;
}

export interface WireEventParams {
  type: string;
  payload?: Record<string, unknown>;
}

export interface WireRequestParams {
  type: string;
  payload?: Record<string, unknown>;
}

export interface WireRequestEnvelope {
  rpcId: string;
  params: WireRequestParams;
}

export interface WireJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: WireJsonRpcError;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pythonShebangCommand(executable: string, args: string[]): { command: string; args: string[] } {
  try {
    const firstLine = readFileSync(executable, "utf8").split(/\r?\n/, 1)[0] || "";
    if (!firstLine.startsWith("#!") || !/python/i.test(firstLine)) {
      return { command: executable, args };
    }
    const shebang = firstLine.slice(2).trim();
    if (!shebang) return { command: executable, args };
    const parts = shebang.split(/\s+/);
    if (basename(parts[0]) === "env" && parts[1]) {
      return { command: parts[0], args: [parts[1], executable, ...args] };
    }
    return { command: parts[0], args: [...parts.slice(1), executable, ...args] };
  } catch {
    return { command: executable, args };
  }
}

function pythonInterpreterFromShebang(executable: string): string | null {
  try {
    const firstLine = readFileSync(executable, "utf8").split(/\r?\n/, 1)[0] || "";
    if (!firstLine.startsWith("#!") || !/python/i.test(firstLine)) return null;
    const shebang = firstLine.slice(2).trim();
    if (!shebang) return null;
    const parts = shebang.split(/\s+/);
    if (basename(parts[0]) === "env" && parts[1]) return parts[1];
    return parts[0];
  } catch {
    return null;
  }
}

let proxyPath: string | null = null;

function ensurePythonProxy(): string {
  if (proxyPath && existsSync(proxyPath)) return proxyPath;
  const path = join(tmpdir(), "pixel-agents-kimi-wire-proxy.py");
  writeFileSync(
    path,
    `#!/usr/bin/env python3
import subprocess
import sys
import threading

cmd = sys.argv[1:]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def pump_stdin():
    try:
        while True:
            data = sys.stdin.buffer.readline()
            if not data:
                break
            proc.stdin.write(data)
            proc.stdin.flush()
    except BrokenPipeError:
        pass
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass

def pump_stream(src, dst):
    while True:
        data = src.readline()
        if not data:
            break
        dst.write(data)
        dst.flush()

threads = [
    threading.Thread(target=pump_stdin, daemon=True),
    threading.Thread(target=pump_stream, args=(proc.stdout, sys.stdout.buffer), daemon=True),
    threading.Thread(target=pump_stream, args=(proc.stderr, sys.stderr.buffer), daemon=True),
]
for thread in threads:
    thread.start()
try:
    raise SystemExit(proc.wait())
finally:
    if proc.poll() is None:
        proc.terminate()
`,
  );
  chmodSync(path, 0o755);
  proxyPath = path;
  return path;
}

function bunPythonProxyCommand(executable: string, args: string[]): { command: string; args: string[] } | null {
  if (!(globalThis as typeof globalThis & { Bun?: unknown }).Bun) return null;
  const python = pythonInterpreterFromShebang(executable);
  if (!python) return null;
  return { command: python, args: [ensurePythonProxy(), executable, ...args] };
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

const TODO_STATUSES = new Set<AgentTodoStatus>(["pending", "in_progress", "done"]);

function normalizeTodoStatus(value: unknown): AgentTodoStatus {
  return typeof value === "string" && TODO_STATUSES.has(value as AgentTodoStatus)
    ? value as AgentTodoStatus
    : "pending";
}

function normalizeTodoItems(value: unknown): AgentTodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: AgentTodoItem[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    todos.push({ title, status: normalizeTodoStatus(record.status) });
  }
  return todos;
}

function oneLine(value: unknown, maxLen: number): string {
  const text = typeof value === "string" ? value : "";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, maxLen - 1)}…`;
}

export function contentPartText(payload: Record<string, unknown>): { role: "assistant" | "thinking" | "system"; text: string } | null {
  if (payload.type === "text" && typeof payload.text === "string") {
    return { role: "assistant", text: payload.text };
  }
  if (payload.type === "think" && typeof payload.think === "string") {
    return { role: "thinking", text: payload.think };
  }
  if (payload.type === "image_url") return { role: "system", text: "[image]" };
  if (payload.type === "audio_url") return { role: "system", text: "[audio]" };
  if (payload.type === "video_url") return { role: "system", text: "[video]" };
  return null;
}

export function contentInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const pieces: string[] = [];
  for (const part of input) {
    const record = asRecord(part);
    if (record.type === "text" && typeof record.text === "string") pieces.push(record.text);
    if (record.type === "think" && typeof record.think === "string") pieces.push(record.think);
  }
  return pieces.join("\n").trim();
}

export function extractWireTodoList(payload: Record<string, unknown>): AgentTodoItem[] | null {
  const fn = asRecord(payload.function);
  if (fn.name === "SetTodoList") {
    return normalizeTodoItems(parseToolArguments(fn.arguments).todos);
  }

  const returnValue = asRecord(payload.return_value);
  const display = Array.isArray(returnValue.display) ? returnValue.display : [];
  for (const block of display) {
    const record = asRecord(block);
    if (record.type !== "todo") continue;
    return normalizeTodoItems(record.items ?? record.todos);
  }

  return null;
}

export function formatWireToolStatus(payload: Record<string, unknown>): { toolId: string; toolName: string; status: string } | null {
  const toolId = typeof payload.id === "string" ? payload.id : "";
  const fn = asRecord(payload.function);
  const toolName = typeof fn.name === "string" ? fn.name : "";
  if (!toolId || !toolName) return null;

  const input = parseToolArguments(fn.arguments);
  const base = (p: unknown) => (typeof p === "string" ? basename(p) : "");

  let status: string;
  switch (toolName) {
    case "Read":
      status = `Reading ${base(input.file_path)}`;
      break;
    case "Edit":
      status = `Editing ${base(input.file_path)}`;
      break;
    case "Write":
      status = `Writing ${base(input.file_path)}`;
      break;
    case "Bash":
    case "Shell": {
      const command = oneLine(input.command ?? input.cmd ?? input.input, 31);
      status = command ? `Running: ${command}` : `Running ${toolName}`;
      break;
    }
    case "Glob":
      status = "Searching files";
      break;
    case "Grep":
      status = "Searching code";
      break;
    case "WebFetch":
      status = "Fetching web content";
      break;
    case "WebSearch":
      status = "Searching the web";
      break;
    case "Agent":
    case "Task": {
      const desc = oneLine(input.description, 41);
      status = desc ? `Subtask: ${desc}` : "Running subtask";
      break;
    }
    case "AskUserQuestion":
      status = "Waiting for your answer";
      break;
    case "EnterPlanMode":
      status = "Planning";
      break;
    case "ExitPlanMode":
      status = "Submitting plan";
      break;
    case "SetTodoList":
      status = "Updating TODO list";
      break;
    default:
      status = `Using ${toolName}`;
      break;
  }

  return { toolId, toolName, status };
}

export function requestDisplayText(params: WireRequestParams): string {
  const payload = asRecord(params.payload);
  if (params.type === "ApprovalRequest") {
    return oneLine(payload.description ?? payload.action ?? "Approval required", 180) || "Approval required";
  }
  if (params.type === "QuestionRequest") {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const first = asRecord(questions[0]);
    const header = typeof first.header === "string" && first.header.trim() ? `${first.header.trim()}: ` : "";
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    return oneLine(`${header}${typeof first.question === "string" ? first.question : "Question from Kimi"}${more}`, 180) || "Question from Kimi";
  }
  if (params.type === "ToolCallRequest") {
    return `External tool request: ${typeof payload.name === "string" ? payload.name : "unknown"}`;
  }
  return `${params.type || "Request"} needs a response`;
}

export class KimiWireSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(private readonly options: KimiWireOptions) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) return;
    const args = ["--work-dir", this.options.cwd, "--wire"];
    if (this.options.yolo) args.push("--yolo");
    const command = bunPythonProxyCommand(this.options.executable, args)
      ?? pythonShebangCommand(this.options.executable, args);

    this.child = spawn(command.command, command.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.child.on("error", (err) => {
      this.rejectAll(err);
      this.emit("error", err);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(`Kimi Wire process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`);
      this.rejectAll(err);
      this.emit("exit", { code, signal });
    });
  }

  async initialize(): Promise<unknown> {
    this.start();
    return this.request("initialize", {
      protocol_version: "1.9",
      client: {
        name: "pixel-agents-kimi",
        version: "0.1.0",
      },
      capabilities: {
        supports_question: true,
        supports_plan_mode: true,
      },
    });
  }

  prompt(userInput: string): Promise<unknown> {
    return this.request("prompt", { user_input: userInput });
  }

  steer(userInput: string): Promise<unknown> {
    return this.request("steer", { user_input: userInput });
  }

  cancel(): Promise<unknown> {
    return this.request("cancel", {});
  }

  replay(): Promise<unknown> {
    return this.request("replay", {});
  }

  setPlanMode(enabled: boolean): Promise<unknown> {
    return this.request("set_plan_mode", { enabled });
  }

  respond(rpcId: string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id: rpcId, result });
  }

  dispose(): void {
    this.closed = true;
    this.rejectAll(new Error("Kimi Wire session disposed"));
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.destroy();
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2_000).unref();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Kimi Wire session is closed"));
    this.start();
    const id = randomUUID();
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.write(message);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private write(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("Kimi Wire stdin is not writable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
    this.emit("send", message);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("protocolError", new Error(`Non-JSON Wire stdout: ${line.slice(0, 300)}`));
      return;
    }

    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error)) {
      const id = String(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error) {
        const err = new Error(`${pending.method} failed: ${msg.error.message}`);
        (err as Error & { code?: number; data?: unknown }).code = msg.error.code;
        (err as Error & { code?: number; data?: unknown }).data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "event") {
      this.emit("wireEvent", asRecord(msg.params) as unknown as WireEventParams);
      return;
    }

    if (msg.method === "request" && msg.id !== undefined && msg.id !== null) {
      this.emit("wireRequest", {
        rpcId: String(msg.id),
        params: asRecord(msg.params) as unknown as WireRequestParams,
      } satisfies WireRequestEnvelope);
      return;
    }

    this.emit("protocolMessage", msg);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}
