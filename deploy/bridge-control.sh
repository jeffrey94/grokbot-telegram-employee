#!/bin/sh
set -eu
umask 077

BRIDGE_HOME=${BRIDGE_HOME:-/home/box/grokbot-telegram-bridge}
PID_FILE="$BRIDGE_HOME/bridge.pid"
LOG_FILE="$BRIDGE_HOME/bridge.log"
ENV_FILE="$BRIDGE_HOME/.env"
LOCK_DIR="$BRIDGE_HOME/.control-lock"

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    case "$lock_pid" in
      (*[!0-9]*|'') lock_pid= ;;
    esac
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "Another bridge-control command is running" >&2
      exit 1
    fi
    rm -f "$LOCK_DIR/pid"
    if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "Could not recover the stale control lock" >&2
      exit 1
    fi
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  trap 'rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
  trap 'exit 130' HUP INT TERM
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE")
  case "$pid" in (*[!0-9]*|'') return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" = "$BRIDGE_HOME" ] || return 1
  command=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  case "$command" in
    (*" --env-file=$ENV_FILE src/main.js "*) return 0 ;;
    (*) return 1 ;;
  esac
}

start() {
  if is_running; then
    echo "Bridge is already running"
    return
  fi
  rm -f "$PID_FILE"
  if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE" >&2
    exit 1
  fi
  if [ "$(stat -c '%a' "$ENV_FILE")" != "600" ]; then
    echo "$ENV_FILE must have mode 600" >&2
    exit 1
  fi
  cd "$BRIDGE_HOME"
  # Node --env-file does not override existing process env. Clear bridge keys so
  # .env wins (e.g. inherited TELEGRAM_ALLOWED_CHAT_IDS must not drop forum IDs).
  env -u TELEGRAM_BOT_TOKEN \
      -u TELEGRAM_ALLOWED_USER_IDS \
      -u TELEGRAM_ALLOWED_CHAT_IDS \
      -u TELEGRAM_ALLOWED_TOPIC_IDS \
      -u TELEGRAM_TOPIC_NAMES \
      -u TELEGRAM_TOPIC_AGENTS \
      -u TELEGRAM_GROUP_KEYWORDS \
      -u TELEGRAM_GROUP_HINT \
      -u TELEGRAM_VOICE_PROMPT_HINT \
      -u TELEGRAM_MEDIA_BUNDLING \
      -u TELEGRAM_BUNDLE_ALBUM_DEBOUNCE_MS \
      -u TELEGRAM_BUNDLE_BURST_WINDOW_MS \
      -u TELEGRAM_BUNDLE_MAX_WAIT_MS \
      -u TELEGRAM_BUNDLE_MAX_ITEMS \
      -u GROK_GATEWAY_URL \
      -u GROK_GATEWAY_TOKEN \
      -u GROK_GATEWAY_TOKEN_FILE \
      -u GROK_DEFAULT_AGENT \
      -u BRIDGE_STATE_PATH \
      -u GROK_REPLY_TIMEOUT_MS \
      -u GROK_POLL_INTERVAL_MS \
      -u GROK_DESKTOP_MIRROR_CHAT_ID \
      -u GROK_DESKTOP_MIRROR_USER_ID \
      nohup node --env-file="$ENV_FILE" src/main.js >>"$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Bridge failed to start; inspect $LOG_FILE" >&2
    exit 1
  fi
  echo "Bridge started"
}

stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "Bridge is not running"
    return
  fi
  pid=$(cat "$PID_FILE")
  kill "$pid"
  remaining=20
  while kill -0 "$pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
    sleep 1
    remaining=$((remaining - 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Bridge did not stop within 20 seconds" >&2
    return 1
  fi
  rm -f "$PID_FILE"
  echo "Bridge stopped"
}

status() {
  if is_running; then
    echo "Bridge is running"
  else
    echo "Bridge is not running"
    exit 1
  fi
}

case "${1:-}" in
  start) acquire_lock; start ;;
  stop) acquire_lock; stop ;;
  restart) acquire_lock; stop; start ;;
  ensure) acquire_lock; is_running || start ;;
  status) status ;;
  *) echo "Usage: $0 {start|stop|restart|ensure|status}" >&2; exit 2 ;;
esac
