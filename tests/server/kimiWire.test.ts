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
} from "../../server/kimiWire.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createFakeKimiWireExecutable(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "pixel-agents-wire-"));
  tempDirs.push(tempDir);
  const fakeKimi = join(tempDir, "fake-kimi-wire.js");

  writeFileSync(
    fakeKimi,
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
  chmodSync(fakeKimi, 0o755);
  return fakeKimi;
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
});
