#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE=0
APPROVED=0
BINARY=""
MODEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --approve-billable) APPROVED=1; shift ;;
    --model)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Expected a Provider/model after --model.\n' >&2; exit 1; }
      MODEL="$2"; shift 2 ;;
    --binary)
      [[ $# -ge 2 && -x "$2" && "$2" == /* ]] || { printf 'Expected an absolute executable binary path.\n' >&2; exit 1; }
      BINARY="$2"; shift 2 ;;
    *) printf 'Unknown smoke option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
if [[ "$LIVE" == 1 && ( "$APPROVED" != 1 || -z "$MODEL" ) ]]; then
  printf 'Live smoke requires --approve-billable and --model provider/model.\n' >&2
  exit 1
fi
if [[ "$LIVE" == 0 && -n "$MODEL" ]]; then
  printf '%s\n' '--model is only valid with --live.' >&2
  exit 1
fi
BRANCH_EXPORT_SMOKE=0
if [[ "$LIVE" == 0 && -z "$BINARY" ]]; then
  BRANCH_EXPORT_SMOKE=1
fi
for command in bun tmux; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s is required for the interactive smoke.\n' "$command" >&2
    exit 1
  fi
done
BUN_PATH="$(command -v bun)"
PATH_VALUE="$(dirname "$BUN_PATH"):/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
SESSION="wincode-tui-$(date +%s)-$$"
umask 077
TEST_HOME="$(mktemp -d)"
TEST_HOME="$(cd "$TEST_HOME" && pwd -P)"
WORKSPACE="$TEST_HOME/workspace"
FRAME=""
ARTIFACT_DIR="${WINCODE_SMOKE_ARTIFACT_DIR:-$ROOT/test-artifacts/interactive-smoke}"
mkdir -p "$ARTIFACT_DIR"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
SMOKE_PLUGIN="$ROOT/packages/coding-agent/test/support/interactive-smoke-provider.ts"
if [[ "$LIVE" == 0 && -n "$BINARY" ]]; then
  SMOKE_PLUGIN="$TEST_HOME/interactive-smoke-provider.ts"
  "$BUN_PATH" build \
    "$ROOT/packages/coding-agent/test/support/interactive-smoke-provider.ts" \
    --target=bun --format=cjs --outfile "$SMOKE_PLUGIN"
fi
# A separate server/socket and empty config avoid touching the user's tmux sessions.
tmux() { command tmux -L "$SESSION" -f /dev/null "$@"; }
cleanup() {
  local status=$?
  if [[ "$status" != 0 && "$LIVE" == 0 ]]; then
    tmux capture-pane -t "$SESSION" -p -S -200 > "$ARTIFACT_DIR/failure-frame.txt" 2>/dev/null || true
    if [[ -d "$TEST_HOME/.wincode/logs" ]]; then
      cp -R "$TEST_HOME/.wincode/logs" "$ARTIFACT_DIR/" || true
    fi
  fi
  tmux kill-server 2>/dev/null || true
  rm -rf "$TEST_HOME"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$TEST_HOME/data" "$TEST_HOME/config" "$TEST_HOME/tmp" \
  "$WORKSPACE/.wincode"
cp "$ROOT/scripts/test-support/interactive-smoke-wincode.json" \
  "$WORKSPACE/.wincode/settings.json"
if [[ "$LIVE" == 1 ]]; then
  SOURCE_HOME="${HOME:-$(cd ~ && pwd -P)}"
  OS_USERNAME="${USER:-${LOGNAME:-$(id -un)}}"
  (
    cd "$ROOT/packages/coding-agent"
    env -i \
      PATH="$PATH_VALUE" \
      HOME="$SOURCE_HOME" \
      USER="$OS_USERNAME" \
      LOGNAME="$OS_USERNAME" \
      TMPDIR="$TEST_HOME/tmp" \
      WINCODE_SMOKE_HOME="$TEST_HOME" \
      WINCODE_SMOKE_SOURCE_HOME="$SOURCE_HOME" \
      WINCODE_SMOKE_SOURCE_XDG_DATA_HOME="${XDG_DATA_HOME:-}" \
      WINCODE_SMOKE_SOURCE_APPDATA="${APPDATA:-}" \
      WINCODE_SMOKE_ISOLATED_XDG_DATA_HOME="$TEST_HOME/data" \
      WINCODE_SMOKE_ISOLATED_APPDATA="$TEST_HOME/appdata" \
      WINCODE_SMOKE_MODEL="$MODEL" \
      "$BUN_PATH" --no-env-file "$ROOT/scripts/test-support/stage-live-smoke-credential.ts"
  )
fi
printf 'smoke-file-content\n' > "$WORKSPACE/smoke-fixture.txt"
tmux new-session -d -s "$SESSION" -x 80 -y 24 -c "$WORKSPACE" \
  -e "WINCODE_SMOKE_HOME=$TEST_HOME" \
  -e "WINCODE_SMOKE_BUN=$BUN_PATH" \
  -e "WINCODE_SMOKE_BINARY=$BINARY" \
  -e "WINCODE_SMOKE_PLUGIN=$SMOKE_PLUGIN" \
  -e "WINCODE_SMOKE_LIVE=$LIVE" \
  -e "WINCODE_SMOKE_APPROVED=$APPROVED" \
  -e "WINCODE_SMOKE_MODEL=$MODEL" \
  -e "WINCODE_SMOKE_BRANCH_EXPORT=$BRANCH_EXPORT_SMOKE" \
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
  capture_frame
  # Prior scripted errors can remain visible while waiting for recovery output.
  local initial_errors
  initial_errors="$(printf '%s\n' "$FRAME" | grep -E '(^|[[:space:]])error:' | LC_ALL=C sort || true)"
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
    local current_errors
    current_errors="$(printf '%s\n' "$FRAME" | grep -E '(^|[[:space:]])error:' | LC_ALL=C sort || true)"
    local new_errors
    new_errors="$(comm -13 <(printf '%s\n' "$initial_errors") <(printf '%s\n' "$current_errors") || true)"
    if [[ -n "$new_errors" ]]; then
      fail_with_frame "Wincode displayed a new error while waiting for '$text'."
    fi
    sleep 0.1
  done
  fail_with_frame "Timed out waiting for '$text'."
}

wait_for_text 'Ask anything...' 150
# The composer appears before Provider model selection has finished loading.
# Wait for the selected smoke model before sending the first keyboard input.
if [[ "$LIVE" == 1 ]]; then
  wait_for_text "$MODEL" 150
else
  wait_for_text 'terminal-smoke/fake' 150
fi
if [[ "$LIVE" == 1 ]]; then
  tmux send-keys -l -t "$SESSION" 'Reply only with smoke followed by a hyphen, live, a hyphen, and ok. Do not use tools.'
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'smoke-live-ok' 900
elif [[ -n "$BINARY" ]]; then
  # Release-binary smoke verifies startup and teardown without a Provider request.
  :
else
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

tmux send-keys -l -t "$SESSION" 'terminal smoke tool'
tmux send-keys -t "$SESSION" Enter
wait_for_text 'tool-roundtrip-ok'
tmux send-keys -l -t "$SESSION" 'terminal smoke error'
tmux send-keys -t "$SESSION" Enter
wait_for_text 'The model request failed.'
tmux send-keys -l -t "$SESSION" 'terminal smoke recover'
tmux send-keys -t "$SESSION" Enter
wait_for_text 'error-recovery-ok'

tmux send-keys -l -t "$SESSION" 'terminal smoke draft'
for size in '100 30' '60 20' '80 24'; do
  read -r width height <<< "$size"
  tmux resize-window -t "$SESSION" -x "$width" -y "$height"
  wait_for_text 'terminal smoke draft'
  [[ "$(tmux display-message -p -t "$SESSION" '#{window_width}x#{window_height}')" == "${width}x${height}" ]] || \
    fail_with_frame 'tmux did not apply the requested resize.'
  capture_frame
  printf '%s\n' "$FRAME" > "$ARTIFACT_DIR/resize-${width}x${height}.txt"
done
tmux send-keys -t "$SESSION" C-c
wait_for_text 'Ask anything...'

if [[ "$BRANCH_EXPORT_SMOKE" == 1 ]]; then
  tmux send-keys -l -t "$SESSION" '/sessions'
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'Search sessions'
  tmux send-keys -l -t "$SESSION" 'branch-export-smoke-source'
  wait_for_text 'branch-export-smoke-source'
  tmux send-keys -t "$SESSION" C-e
  wait_for_text 'Export scope (default: Whole tree)'
  tmux send-keys -l -t "$SESSION" './selected-path-branch.bundle'
  tmux send-keys -t "$SESSION" Tab
  tmux send-keys -t "$SESSION" Down
  sleep 0.1
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'Exported branch Session bundle' 150
  [[ -d "$WORKSPACE/selected-path-branch.bundle" ]] || \
    fail_with_frame 'Selected Path export did not create the bundle directory.'

  rm -f "$WORKSPACE/.smoke-provider-request-seen"
  tmux send-keys -t "$SESSION" C-o
  wait_for_text 'Import a validated local Session bundle'
  tmux send-keys -l -t "$SESSION" './selected-path-branch.bundle'
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'branch smoke selected answer' 150
  sleep 0.5
  [[ ! -e "$WORKSPACE/.smoke-provider-request-seen" ]] || \
    fail_with_frame 'Imported branch began Provider work before explicit input.'
  tmux send-keys -l -t "$SESSION" 'terminal smoke continue imported branch'
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'imported-branch-only' 150
fi
fi
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
EXIT_SIGNAL="$(tmux display-message -p -t "$SESSION" '#{pane_dead_signal}')"
[[ "$EXIT_STATUS" == '0' ]] || \
  fail_with_frame "TUI exited with status ${EXIT_STATUS:-unknown}${EXIT_SIGNAL:+ (signal $EXIT_SIGNAL)}."
if [[ "$BRANCH_EXPORT_SMOKE" == 1 ]]; then
  OS_USERNAME="${USER:-${LOGNAME:-$(id -un)}}"
  env -i \
    PATH="$PATH_VALUE" \
    HOME="$TEST_HOME" \
    USER="$OS_USERNAME" \
    LOGNAME="$OS_USERNAME" \
    TMPDIR="$TEST_HOME/tmp" \
    XDG_DATA_HOME="$TEST_HOME/data" \
    XDG_CONFIG_HOME="$TEST_HOME/config" \
    XDG_CACHE_HOME="$TEST_HOME/cache" \
    APPDATA="$TEST_HOME/appdata" \
    WINCODE_SMOKE_HOME="$TEST_HOME" \
    WINCODE_SMOKE_WORKSPACE="$WORKSPACE" \
    WINCODE_TEST_SESSION_INDEX_DIR="$TEST_HOME/session-indexes" \
    "$BUN_PATH" --no-env-file \
    "$ROOT/scripts/test-support/verify-interactive-branch-smoke.ts"
fi
if [[ "$LIVE" == 1 ]]; then
  printf 'PASS: live Provider reply and clean /exit.\n'
elif [[ -n "$BINARY" ]]; then
  printf 'PASS: release executable TUI startup and clean /exit; no Provider request sent.\n'
else
  printf 'PASS: faux streaming, cancellation, tool roundtrip, error recovery, resize, clean /exit.\n'
fi
