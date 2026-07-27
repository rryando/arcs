#!/bin/bash
# Stop the brainstorm server and clean up
# Usage: stop-server.sh <screen_dir>
#
# Kills the server process. Only deletes generated /tmp/brainstorm-* session
# roots. Persistent generated directories (.superpowers/) are
# kept so mockups can be reviewed later.

SCREEN_DIR="$1"

if [[ -z "$SCREEN_DIR" ]]; then
  echo '{"error": "Usage: stop-server.sh <screen_dir>"}'
  exit 1
fi

if [[ "$SCREEN_DIR" != /* || "$SCREEN_DIR" =~ (^|/)\.\.(/|$) ]]; then
  echo '{"error": "Invalid brainstorm session root"}'
  exit 1
fi

CANONICAL_DIR="$(realpath -- "$SCREEN_DIR" 2>/dev/null)"
if [[ -z "$CANONICAL_DIR" ]]; then
  echo '{"error": "Brainstorm session root does not exist"}'
  exit 1
fi

EPHEMERAL="false"
if [[ "$CANONICAL_DIR" =~ ^/tmp/brainstorm-[0-9]+-[0-9]+$ ]]; then
  EPHEMERAL="true"
elif [[ ! "$CANONICAL_DIR" =~ ^/.+/\.superpowers/brainstorm/[0-9]+-[0-9]+$ ]]; then
  echo '{"error": "Refusing non-generated brainstorm session root"}'
  exit 1
fi

PID_FILE="${CANONICAL_DIR}/.server.pid"

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null
  rm -f "$PID_FILE" "${CANONICAL_DIR}/.server.log"

  # Only delete ephemeral /tmp directories
  if [[ "$EPHEMERAL" == "true" ]]; then
    rm -rf -- "$CANONICAL_DIR"
  fi

  echo '{"status": "stopped"}'
else
  echo '{"status": "not_running"}'
fi
