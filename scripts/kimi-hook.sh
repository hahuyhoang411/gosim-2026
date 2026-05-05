#!/bin/bash
# pixel-agents-kimi auto-launch hook
# Called from a kimi-cli session-start hook configured in ~/.kimi/config.toml

# Change this to wherever you cloned pixel-agents-kimi-standalone
PIXEL_AGENTS_DIR="$HOME/Desktop/pixel-agents-kimi-standalone"
PORT=3456
PID_FILE="$PIXEL_AGENTS_DIR/.server.pid"

# Health check — catches hung processes and stale PIDs
if curl -sf --connect-timeout 2 "http://localhost:$PORT/" >/dev/null 2>&1; then
  exit 0
fi

# Server not healthy — kill any stale process
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  kill "$OLD_PID" 2>/dev/null
  rm -f "$PID_FILE"
fi

# Start server
cd "$PIXEL_AGENTS_DIR"
node dist/server.js > /tmp/pixel-agents-kimi.log 2>&1 &
echo $! > "$PID_FILE"
