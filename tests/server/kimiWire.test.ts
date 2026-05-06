import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  KimiWireSession,
  contentPartText,
  formatWireToolStatus,
  requestDisplayText,
  type WireEventParams,
  type WireRequestEnvelope,
} from "../../server/kimiWire.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function writeExecutable(prefix: string, fileName: string, source: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  const executable = join(tempDir, fileName);
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  return executable;
}

function createFakeKimiWireExecutable(): string {
  return writeExecutable(
    "pixel-agents-wire-",
    "fake-kimi-wire.js",
    `#!/usr/bin/env node
let buffer = "";
let promptId = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(line) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocol_version: "1.9",
        server: { name: "fake", version: "0" },
        slash_commands: [],
        capabilities: { supports_question: true },
      },
    });
    return;
  }

  if (msg.method === "prompt") {
    promptId = msg.id;
    send({ jsonrpc: "2.0", method: "event", params: { type: "TurnBegin", payload: { user_input: msg.params.user_input } } });
    send({ jsonrpc: "2.0", method: "event", params: { type: "ContentPart", payload: { type: "text", text: "hello from fake wire" } } });
    setTimeout(() => {
      if (promptId === msg.id) {
        send({ jsonrpc: "2.0", method: "event", params: { type: "TurnEnd", payload: {} } });
        send({ jsonrpc: "2.0", id: msg.id, result: { status: "finished" } });
        promptId = null;
      }
    }, 60);
    return;
  }

  if (msg.method === "steer") {
    send({ jsonrpc: "2.0", method: "event", params: { type: "SteerInput", payload: { user_input: msg.params.user_input } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { status: "steered" } });
    return;
  }

  if (msg.method === "cancel") {
    const current = promptId;
    promptId = null;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    if (current) send({ jsonrpc: "2.0", id: current, result: { status: "cancelled" } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(line);
  }
});
`,
  );
}

function createRequestingFakeKimiWireExecutable(kind: "approval" | "question"): string {
  return writeExecutable(
    "pixel-agents-wire-request-",
    "fake-kimi-wire-request.js",
    `#!/usr/bin/env node
const kind = ${JSON.stringify(kind)};
let buffer = "";
let promptId = null;
let requestRpcId = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function finishPrompt(resultKey, result) {
  send({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: kind === "approval" ? "ApprovalResponse" : "ContentPart",
      payload: kind === "approval" ? result : { type: "text", text: "question answered" },
    },
  });
  send({ jsonrpc: "2.0", method: "event", params: { type: "TurnEnd", payload: {} } });
  send({ jsonrpc: "2.0", id: promptId, result: { status: "finished", [resultKey]: result } });
  promptId = null;
  requestRpcId = null;
}

function handle(line) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocol_version: "1.9",
        server: { name: "fake", version: "0" },
        slash_commands: [],
        capabilities: { supports_question: true },
      },
    });
    return;
  }

  if (msg.method === "prompt") {
    promptId = msg.id;
    requestRpcId = kind === "approval" ? "rpc-approval" : "rpc-question";
    send({ jsonrpc: "2.0", method: "event", params: { type: "TurnBegin", payload: { user_input: msg.params.user_input } } });
    if (kind === "approval") {
      send({
        jsonrpc: "2.0",
        method: "request",
        id: requestRpcId,
        params: {
          type: "ApprovalRequest",
          payload: {
            id: "approval-1",
            tool_call_id: "tc-1",
            sender: "Shell",
            action: "run shell command",
            description: "Run command 'rm -rf dist'",
            display: [],
          },
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        method: "request",
        id: requestRpcId,
        params: {
          type: "QuestionRequest",
          payload: {
            id: "question-1",
            tool_call_id: "tc-2",
            questions: [
              {
                question: "Which language should I use?",
                header: "Lang",
                options: [
                  { label: "Python", description: "Large ecosystem" },
                  { label: "Rust", description: "Fast and safe" },
                ],
              },
              {
                question: "Which constraints matter?",
                header: "Rules",
                multi_select: true,
                options: [{ label: "Speed" }, { label: "Safety" }],
              },
            ],
          },
        },
      });
    }
    return;
  }

  if (msg.id === requestRpcId && msg.result) {
    finishPrompt(kind, msg.result);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(line);
  }
});
`,
  );
}

describe("Kimi Wire transport", () => {
  test("maps Wire content/tool/request payloads into observable UI text", () => {
    expect(contentPartText({ type: "text", text: "ok" })).toEqual({ role: "assistant", text: "ok" });
    expect(contentPartText({ type: "think", think: "hidden" })).toEqual({ role: "thinking", text: "hidden" });
    expect(
      formatWireToolStatus({
        id: "tool-1",
        function: { name: "Bash", arguments: JSON.stringify({ command: "echo hello" }) },
      })?.status,
    ).toBe("Running: echo hello");
    expect(
      requestDisplayText({
        type: "ApprovalRequest",
        payload: { description: "Run shell command" },
      }),
    ).toBe("Run shell command");
    expect(
      requestDisplayText({
        type: "QuestionRequest",
        payload: {
          questions: [
            { header: "Lang", question: "Which language should I use?" },
            { header: "Rules", question: "Which constraints matter?" },
          ],
        },
      }),
    ).toBe("Lang: Which language should I use? (+1 more)");
  });

  test("initializes, receives assistant text, and accepts steer during an active turn", async () => {
    const session = new KimiWireSession({ executable: createFakeKimiWireExecutable(), cwd: process.cwd() });
    const events: WireEventParams[] = [];
    session.on("wireEvent", (event: WireEventParams) => events.push(event));

    await session.initialize();
    const promptPromise = session.prompt("say hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const steerResult = await session.steer("make it shorter") as { status?: string };
    const promptResult = await promptPromise as { status?: string };

    expect(steerResult.status).toBe("steered");
    expect(promptResult.status).toBe("finished");
    expect(events).toContainEqual({
      type: "ContentPart",
      payload: { type: "text", text: "hello from fake wire" },
    });
    expect(events.some((event) => event.type === "SteerInput")).toBe(true);
    session.dispose();
  });

  test("surfaces an approval request and sends the exact ApprovalResponse result", async () => {
    const session = new KimiWireSession({ executable: createRequestingFakeKimiWireExecutable("approval"), cwd: process.cwd() });
    const requests: WireRequestEnvelope[] = [];
    const events: WireEventParams[] = [];
    session.on("wireEvent", (event: WireEventParams) => events.push(event));
    session.on("wireRequest", (request: WireRequestEnvelope) => {
      requests.push(request);
      session.respond(request.rpcId, {
        request_id: "approval-1",
        response: "reject",
        feedback: "Use a safer cleanup command.",
      });
    });

    await session.initialize();
    const result = await session.prompt("trigger approval") as {
      approval?: { request_id?: string; response?: string; feedback?: string };
    };

    expect(requests[0].params.type).toBe("ApprovalRequest");
    expect(requests[0].params.payload?.description).toBe("Run command 'rm -rf dist'");
    expect(result.approval).toEqual({
      request_id: "approval-1",
      response: "reject",
      feedback: "Use a safer cleanup command.",
    });
    expect(events).toContainEqual({
      type: "ApprovalResponse",
      payload: {
        request_id: "approval-1",
        response: "reject",
        feedback: "Use a safer cleanup command.",
      },
    });
    session.dispose();
  });

  test("surfaces a structured question request and sends complete QuestionResponse answers", async () => {
    const session = new KimiWireSession({ executable: createRequestingFakeKimiWireExecutable("question"), cwd: process.cwd() });
    const requests: WireRequestEnvelope[] = [];
    session.on("wireRequest", (request: WireRequestEnvelope) => {
      requests.push(request);
      session.respond(request.rpcId, {
        request_id: "question-1",
        answers: {
          "Which language should I use?": "Rust",
          "Which constraints matter?": "Speed, Safety",
        },
      });
    });

    await session.initialize();
    const result = await session.prompt("trigger question") as {
      question?: { request_id?: string; answers?: Record<string, string> };
    };

    expect(requests[0].params.type).toBe("QuestionRequest");
    expect(requests[0].params.payload?.questions).toEqual([
      {
        question: "Which language should I use?",
        header: "Lang",
        options: [
          { label: "Python", description: "Large ecosystem" },
          { label: "Rust", description: "Fast and safe" },
        ],
      },
      {
        question: "Which constraints matter?",
        header: "Rules",
        multi_select: true,
        options: [{ label: "Speed" }, { label: "Safety" }],
      },
    ]);
    expect(result.question).toEqual({
      request_id: "question-1",
      answers: {
        "Which language should I use?": "Rust",
        "Which constraints matter?": "Speed, Safety",
      },
    });
    session.dispose();
  });
});
