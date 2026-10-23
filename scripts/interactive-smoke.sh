#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for command in bun tmux; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s is required for the interactive smoke.\n' "$command" >&2
    exit 1
  fi
done
BUN_PATH="$(command -v bun)"
SESSION="wincode-tui-$(date +%s)-$$"
TEST_HOME="$(mktemp -d)"
WORKSPACE="$TEST_HOME/workspace"
FRAME=""
cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$TEST_HOME"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$TEST_HOME/data" "$TEST_HOME/config" "$TEST_HOME/tmp" \
  "$WORKSPACE/.wincode"
cp "$ROOT/scripts/test-support/interactive-smoke-wincode.json" \
  "$WORKSPACE/.wincode/settings.json"
tmux new-session -d -s "$SESSION" -x 80 -y 24 -c "$WORKSPACE" \
  -e "WINCODE_SMOKE_HOME=$TEST_HOME" \
  -e "WINCODE_SMOKE_BUN=$BUN_PATH" \
  "$ROOT/scripts/test-support/interactive-smoke-launcher.sh"
tmux set-option -p -t "$SESSION" remain-on-exit on

capture_frame() {
  FRAME="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)"
}
fail_with_frame() {
  printf 'FAIL: %s\n' "$1" >&2
  if printf '%s\n' "$FRAME" | grep -Fq 'Pane is dead'; then
    FRAME="$(tmux capture-pane -t "$SESSION" -p -S -100 2>/dev/null || true)"
  fi
  printf '%s\n' "$FRAME" >&2
  exit 1
}
wait_for_text() {
  local text="$1"
  local attempts="${2:-120}"
  for ((attempt = 0; attempt < attempts; attempt++)); do
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      fail_with_frame "tmux session exited before '$text' appeared."
    fi
    capture_frame
    if printf '%s\n' "$FRAME" | grep -Fq 'The Session Writer OS lock could not be established'; then
      printf 'NOT VERIFIED: Wincode could not establish its Session Writer OS lock.\n' >&2
      printf '%s\n' "$FRAME" >&2
      exit 2
    fi
    if printf '%s\n' "$FRAME" | grep -Fq "$text"; then
      return 0
    fi
    if printf '%s\n' "$FRAME" | grep -Eqi '(^|[[:space:]])error:'; then
      fail_with_frame 'Wincode displayed a startup error.'
    fi
    sleep 0.1
  done
  fail_with_frame "Timed out waiting for '$text'."
}

wait_for_text 'Ask anything...' 150
tmux send-keys -l -t "$SESSION" 'terminal smoke stream'
tmux send-keys -t "$SESSION" Enter
wait_for_text 'smoke-stream-one'
capture_frame
if printf '%s\n' "$FRAME" | grep -Fq 'smoke-stream-two'; then
  fail_with_frame 'the second stream chunk appeared before the first-chunk assertion.'
fi
wait_for_text 'smoke-stream-two'

tmux send-keys -l -t "$SESSION" 'terminal smoke cancel'
tmux send-keys -t "$SESSION" Enter
wait_for_text 'cancel-pending'
tmux send-keys -t "$SESSION" Escape
sleep 0.1
tmux send-keys -t "$SESSION" Escape
wait_for_text 'interrupted'
for ((attempt = 0; attempt < 60; attempt++)); do
  if [[ -f "$WORKSPACE/.smoke-cancelled" ]]; then
    break
  fi
  sleep 0.1
done
[[ -f "$WORKSPACE/.smoke-cancelled" ]] || fail_with_frame 'Escape did not abort the fake Provider request.'

wait_for_text 'Ask anything...'
tmux send-keys -l -t "$SESSION" 'terminal smoke after cancel'
tmux send-keys -t "$SESSION" Enter
wait_for_text 'after-cancel-ok'

tmux send-keys -l -t "$SESSION" 'terminal smoke draft'
tmux resize-window -t "$SESSION" -x 100 -y 30
wait_for_text 'terminal smoke draft'
[[ "$(tmux display-message -p -t "$SESSION" '#{window_width}x#{window_height}')" == '100x30' ]] || \
  fail_with_frame 'tmux did not apply the requested resize.'
tmux send-keys -t "$SESSION" C-c
wait_for_text 'Ask anything...'
tmux send-keys -l -t "$SESSION" '/exit'
tmux send-keys -t "$SESSION" Enter

for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ "$(tmux display-message -p -t "$SESSION" '#{pane_dead}' 2>/dev/null || true)" == '1' ]]; then
    break
  fi
  sleep 0.1
done
[[ "$(tmux display-message -p -t "$SESSION" '#{pane_dead}' 2>/dev/null || true)" == '1' ]] || \
  fail_with_frame 'the /exit command did not stop the TUI.'
EXIT_STATUS="$(tmux display-message -p -t "$SESSION" '#{pane_dead_status}')"
[[ "$EXIT_STATUS" == '0' ]] || fail_with_frame "TUI exited with status $EXIT_STATUS."
printf 'PASS: prompt streaming, Escape cancellation, resize, and clean /exit.\n'
