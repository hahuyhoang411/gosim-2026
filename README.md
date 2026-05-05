# Pixel Agents Standalone — kimi-cli edition

A standalone web app that visualizes your **[kimi-cli](https://github.com/MoonshotAI/kimi-cli)** sessions as pixel art characters working in a virtual office.

Each kimi-cli agent becomes a character that walks around, sits at a desk, and visually reflects what it's doing — writing code, running tools, waiting for permission, or idle.

> **Forked from `pixel-agents-standalone` (originally a Claude Code visualizer).**
> The watcher and parser have been rewritten to read kimi-cli's session transcripts under `~/.kimi/sessions/`. UI, sprites, and layout editor are unchanged.

## What's Different from the Claude Code version

| Claude Code version | This version (kimi-cli) |
|---|---|
| Watches `~/.claude/projects/<hash>/<session>.jsonl` | Watches `~/.kimi/sessions/<workdir-hash>/<session-id>/context.jsonl` |
| Parses Claude record schema (`type: "assistant"`, `tool_use` blocks) | Parses kimi/OpenAI-style schema (`role: "assistant"`, `tool_calls[].function.{name, arguments}`, `role: "tool"` with `tool_call_id`) |
| Subagent viz via `progress` records with `parentToolUseID` | Watches kimi `subagents/<id>/context.jsonl`, FIFO-pairs each file with the nearest unpaired `Agent`/`Task` tool call, and nests subagent tool activity under the parent bubble |
| `system/turn_duration` event marks end of turn | Pure silence-based idle detection (5s after text reply, 2min stuck-tool fallback) |

## Quick Start

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
npm start
```

Open `http://localhost:3456` in your browser. The server scans `~/.kimi/sessions/` for sessions modified in the last 10 minutes and shows agents in real time.

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
npm run dev
```

Runs the Express server (hot-reload via `tsx watch`) and Vite dev server concurrently.

## Architecture

- **Server** (`server/`) — Express + WebSocket. Watches `context.jsonl` files, parses agent activity, serves the UI.
- **Watcher** (`server/watcher.ts`) — Walks `~/.kimi/sessions/<workdir-hash>/<session-id>/`, tails parent and subagent `context.jsonl` files, and polls `state.json` titles for live agent renames.
- **Parser** (`server/parser.ts`) — Translates kimi `role`-discriminated records and `tool_calls[]` into the same internal events the UI consumes.
- **UI** (`webview-ui/`) — React + Canvas 2D game engine with pathfinding, sprite animation, and an office layout editor.

## Known Limitations / TODO

- **Subagent pairing is heuristic.** kimi-cli stores subagent transcripts under separate paths (`subagents/<id>/context.jsonl`), so this app pairs each newly detected subagent file to the oldest unpaired parent `Agent`/`Task` tool call.
- **Project name is the workdir-hash short id** (e.g. `a3f4b1`) unless `state.json.title` is set, since kimi hashes the workdir path with MD5. Set a session title in kimi-cli to get a friendlier label.
- **No `turn_duration` signal.** Idle is inferred from silence — works in practice but reacts a few seconds slower than the Claude version.

## Office Tileset

Same as upstream. The built-in layout uses basic furniture; for the full 452-piece catalog, purchase the [Office Interior Tileset](https://donarg.itch.io/office-interior-tileset-16x16) by Donarg ($2 on itch.io), place it at `assets/office_tileset_16x16.png`, and run:

```bash
npm run extract-furniture
```

## Credits

- **[pixel-agents](https://github.com/pablodelucca/pixel-agents)** by Pablo De Lucca — original VS Code extension (MIT)
- **[kimi-cli](https://github.com/MoonshotAI/kimi-cli)** by MoonshotAI — the CLI being visualized
- **[Office Interior Tileset](https://donarg.itch.io/office-interior-tileset-16x16)** by Donarg — pixel art furniture (purchased separately)

## License

MIT
