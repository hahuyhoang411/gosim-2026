# Pixel Agents Standalone — kimi-cli edition

A standalone web app that visualizes your **[kimi-cli](https://github.com/MoonshotAI/kimi-cli)** sessions as pixel art characters working in a virtual office.

Each kimi-cli agent becomes a character that walks around, sits at a desk, and visually reflects what it's doing — writing code, running tools, waiting for permission, or idle.

[▶️ Watch the demo](./WhatsApp%20Video%202026-05-06%20at%2012.02.30.mp4)

## What It Is

A **virtual research lab** where your kimi-cli AI agents appear as pixel-art characters who work, debate, take coffee breaks, and collaborate in real time.

Each agent gets a desk and a role — researcher, critic, writer, coordinator. They write shared TODOs on a team whiteboard, hold meetings around the conference table, and walk over to your desk when they need you. You watch the whole lab live in your browser, and click any agent to inspect what they're doing.

## Why It Matters

When you run multiple AI agents, you have no idea what they're doing until you dig through logs. Are they stuck? Arguing? Waiting for you to answer a question? You lose oversight and miss the moment to step in.

This project turns invisible background jobs into a **visible team you can watch and guide**. You see agents gather for a meeting, spot a red error badge from across the room, and jump in exactly when human judgment is needed. The sidebar tells you who needs what, so you never have to grep a log file to understand your own agents.

## Tech Stack

| Layer | Stack |
|---|---|
| **Backend** | Node.js, TypeScript, Express, WebSocket (`ws`), `chokidar` |
| **Frontend** | React 19, TypeScript, Vite |
| **Graphics** | HTML5 Canvas 2D (sprite animation, pathfinding) |
| **Runtime** | Bun, `tsx`, `esbuild` |

## What's Different from the Claude Code version

| Claude Code version | This version (kimi-cli) |
|---|---|
| Watches `~/.claude/projects/<hash>/<session>.jsonl` | Watches `~/.kimi/sessions/<workdir-hash>/<session-id>/context.jsonl` |
| Parses Claude record schema (`type: "assistant"`, `tool_use` blocks) | Parses kimi/OpenAI-style schema (`role: "assistant"`, `tool_calls[].function.{name, arguments}`, `role: "tool"` with `tool_call_id`) |
| Subagent viz via `progress` records with `parentToolUseID` | Watches kimi `subagents/<id>/context.jsonl`, FIFO-pairs each file with the nearest unpaired `Agent`/`Task` tool call, and nests subagent tool activity under the parent bubble |
| `system/turn_duration` event marks end of turn | Pure silence-based idle detection (5s after text reply, 2min stuck-tool fallback) |

## Quick Start

```bash
bun install
bun install --cwd webview-ui
bun run build
bun run start
```

Open `http://localhost:3456` in your browser. The server scans `~/.kimi/sessions/` for sessions modified in the last 10 minutes and shows agents in real time.

## Using the App

- **Resume a Kimi session:** click `+ Agent` in the lower-left toolbar. The button opens a local session picker populated from `~/.kimi/sessions/` and `~/.kimi/kimi.json`. Selecting a session launches `kimi --work-dir <path> --session <session-id>` in Terminal.
- **Inspect an agent:** click an agent in the office or in the right sidebar. The sidebar shows its presence, latest tool, latest subagent, and the last 20 timeline events.
- **Read activity at a glance:** agent labels and sidebar badges use a shared presence taxonomy: `Idle`, `Work`, `Sub`, `Approval`, `Wait`, and `Error`.
- **Track subagents:** when kimi-cli creates a subagent through the `Agent`/`Task` tool, the app creates a child character and nests its tool activity under the parent agent.
- **Edit the office:** click `Layout` to move desks, seats, and furniture. Layout and seat assignments are saved under `~/.pixel-agents/`.

## Auto-Launch with kimi-cli

To start the server automatically when a kimi-cli session begins, add a hook to `~/.kimi/config.toml`:

```toml
[[hooks]]
event = "session_start"
command = "/path/to/pixel-agents-kimi-standalone/scripts/kimi-hook.sh"
```

Edit `scripts/kimi-hook.sh` and set `PIXEL_AGENTS_DIR` to wherever you cloned this repo.

> The exact event name and available hook keys depend on your kimi-cli version — check the hooks docs or `~/.kimi/config.toml` examples shipped with kimi-cli.

## Development

```bash
bun run dev
```

Runs the Express server (hot-reload via `tsx watch`) and Vite dev server concurrently.

## Architecture

- **Server** (`server/`) — Express + WebSocket. Watches `context.jsonl` files, parses agent activity, serves the UI.
- **Watcher** (`server/watcher.ts`) — Walks `~/.kimi/sessions/<workdir-hash>/<session-id>/`, tails parent and subagent `context.jsonl` files, and polls `state.json` titles for live agent renames.
- **Parser** (`server/parser.ts`) — Translates kimi `role`-discriminated records and `tool_calls[]` into the same internal events the UI consumes.
- **Session launcher** (`server/index.ts`) — Lists local kimi sessions by workdir MD5 hash and resumes selected sessions with `kimi --session`.
- **UI** (`webview-ui/`) — React + Canvas 2D game engine with pathfinding, sprite animation, an office layout editor, agent sidebar, and client-side timeline.

## Known Limitations / TODO

- **Subagent pairing is heuristic.** kimi-cli stores subagent transcripts under separate paths (`subagents/<id>/context.jsonl`), so this app pairs each newly detected subagent file to the oldest unpaired parent `Agent`/`Task` tool call.
- **Session picker depends on kimi's local metadata.** Workdir paths are recovered from `~/.kimi/kimi.json`; if a hash has no matching path entry, the picker still shows the session but cannot infer the original workdir.
- **Agent names are inferred locally.** The app uses `state.json.title`, then `state.json.custom_title`, then the first user prompt in `context.jsonl`; only sessions with none of those fall back to the workdir-hash short id.
- **No `turn_duration` signal.** Idle is inferred from silence — works in practice but reacts a few seconds slower than the Claude version.

## Office Tileset

Same as upstream. The built-in layout uses basic furniture; for the full 452-piece catalog, purchase the [Office Interior Tileset](https://donarg.itch.io/office-interior-tileset-16x16) by Donarg ($2 on itch.io), place it at `assets/office_tileset_16x16.png`, and run:

```bash
bun run extract-furniture
```

## Credits

- **[pixel-agents](https://github.com/pablodelucca/pixel-agents)** by Pablo De Lucca — original VS Code extension (MIT)
- **[kimi-cli](https://github.com/MoonshotAI/kimi-cli)** by MoonshotAI — the CLI being visualized
- **[Office Interior Tileset](https://donarg.itch.io/office-interior-tileset-16x16)** by Donarg — pixel art furniture (purchased separately)

## License

MIT
