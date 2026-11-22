#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE=0
APPROVED=0
BINARY=""
MODEL=""
PLUGIN_UI_SMOKE=0
PACKED_PLUGIN_SMOKE=0
PUBLISHED_PLUGIN_SMOKE=0
PACKED_CLI=""
TRUST_FLAG="--trust"
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
    --plugin-ui) PLUGIN_UI_SMOKE=1; shift ;;
    --packed-plugin) PACKED_PLUGIN_SMOKE=1; PLUGIN_UI_SMOKE=1; shift ;;
    --published-plugin) PACKED_PLUGIN_SMOKE=1; PUBLISHED_PLUGIN_SMOKE=1; PLUGIN_UI_SMOKE=1; shift ;;
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
if [[ "$PLUGIN_UI_SMOKE" == 1 && ( "$LIVE" == 1 || -n "$BINARY" ) ]]; then
  printf '%s\n' 'Plugin UI smoke requires the fake Provider and does not support --binary.' >&2
  exit 1
fi
BRANCH_EXPORT_SMOKE=0
if [[ "$LIVE" == 0 && -z "$BINARY" && "$PLUGIN_UI_SMOKE" == 0 ]]; then
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
EXTRA_PLUGIN=""
if [[ "$PLUGIN_UI_SMOKE" == 1 ]]; then
  EXTRA_PLUGIN="$ROOT/packages/coding-agent/test/support/interactive-plugin-ui-smoke.tsx"
fi
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
if [[ "$PACKED_PLUGIN_SMOKE" == 1 ]]; then
  STAGE_ARGS=("$WORKSPACE")
  if [[ "$PUBLISHED_PLUGIN_SMOKE" == 1 ]]; then
    STAGE_ARGS+=(--published)
  fi
  HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/config" XDG_DATA_HOME="$TEST_HOME/data" \
    "$BUN_PATH" --no-env-file "$ROOT/scripts/test-support/stage-packed-plugin-smoke.ts" "${STAGE_ARGS[@]}"
  PACKED_CLI="$WORKSPACE/node_modules/.bin/wincode"
  TRUST_FLAG=$(<"$TEST_HOME/trust-flag")
  SMOKE_PLUGIN="$WORKSPACE/interactive-smoke-provider.ts"
  EXTRA_PLUGIN="$WORKSPACE/.wincode/plugins/external-smoke/interactive-plugin-ui-smoke.tsx"
fi
tmux new-session -d -s "$SESSION" -x 80 -y 24 -c "$WORKSPACE" \
  -e "WINCODE_SMOKE_HOME=$TEST_HOME" \
  -e "WINCODE_SMOKE_BUN=$BUN_PATH" \
  -e "WINCODE_SMOKE_BINARY=$BINARY" \
  -e "WINCODE_SMOKE_PACKED_CLI=$PACKED_CLI" \
  -e "WINCODE_SMOKE_TRUST_FLAG=$TRUST_FLAG" \
  -e "WINCODE_SMOKE_PLUGIN=$SMOKE_PLUGIN" \
  -e "WINCODE_SMOKE_LIVE=$LIVE" \
  -e "WINCODE_SMOKE_APPROVED=$APPROVED" \
  -e "WINCODE_SMOKE_MODEL=$MODEL" \
  -e "WINCODE_SMOKE_BRANCH_EXPORT=$BRANCH_EXPORT_SMOKE" \
  -e "WINCODE_SMOKE_EXTRA_PLUGIN=$EXTRA_PLUGIN" \
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
wait_for_file() {
  local file="$1"
  local attempts="${2:-120}"
  for ((attempt = 0; attempt < attempts; attempt++)); do
    [[ -f "$file" ]] && return 0
    sleep 0.1
  done
  fail_with_frame "Timed out waiting for smoke artifact '$file'."
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
if [[ "$PACKED_PLUGIN_SMOKE" == 1 ]]; then
  tmux send-keys -l -t "$SESSION" 'terminal smoke tool external'
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'external-tool-roundtrip-ok'
fi
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
if [[ "$PLUGIN_UI_SMOKE" == 1 && "$PACKED_PLUGIN_SMOKE" == 0 ]]; then
  tmux send-keys -l -t "$SESSION" '/smoke-editor-turn'
  wait_for_text 'smoke-editor-turn' 150
  tmux send-keys -t "$SESSION" Tab
  tmux send-keys -t "$SESSION" Enter
  wait_for_text 'Smoke custom overlay' 150
  wait_for_file "$WORKSPACE/.smoke-editor-command-started"
  wait_for_file "$WORKSPACE/.smoke-editor-command-context"
  wait_for_file "$WORKSPACE/.smoke-custom-editor-mounted"
  wait_for_file "$WORKSPACE/.smoke-custom-editor-turn-progress"
  wait_for_file "$WORKSPACE/.smoke-custom-editor-turn-terminal"
  wait_for_file "$WORKSPACE/.smoke-custom-overlay-state"
  IFS= read -r COMMAND_CONTEXT < "$WORKSPACE/.smoke-editor-command-context" || true
  [[ "$COMMAND_CONTEXT" == 'session:sdk' ]] || fail_with_frame 'The custom overlay Plugin did not receive its active Session SDK.'
  IFS= read -r TURN_TERMINAL < "$WORKSPACE/.smoke-custom-editor-turn-terminal" || true
  [[ "$TURN_TERMINAL" == 'agent-turn-completed' ]] || fail_with_frame "The custom overlay smoke Agent Turn ended as '$TURN_TERMINAL'."
  capture_frame
  printf '%s\n' "$FRAME" | grep -Fq 'Smoke custom overlay' || \
    fail_with_frame 'The custom overlay closed before its Agent Turn completed.'

  OVERLAY_STATE_FILE="$WORKSPACE/.smoke-custom-overlay-state"
  IFS= read -r INITIAL_OVERLAY_STATE < "$OVERLAY_STATE_FILE" || true
  tmux resize-window -t "$SESSION" -x 50 -y 16
  for ((attempt = 0; attempt < 120; attempt++)); do
    IFS= read -r CURRENT_OVERLAY_STATE < "$OVERLAY_STATE_FILE" || true
    [[ "$CURRENT_OVERLAY_STATE" != "$INITIAL_OVERLAY_STATE" ]] && break
    sleep 0.1
  done
  [[ "$CURRENT_OVERLAY_STATE" != "$INITIAL_OVERLAY_STATE" ]] || fail_with_frame 'The custom overlay bounds did not update after terminal resize.'
  capture_frame
  printf '%s\n' "$FRAME" | grep -Fq 'Smoke custom overlay' || fail_with_frame 'The custom overlay was lost during terminal resize.'

  tmux send-keys -t "$SESSION" f
  for ((attempt = 0; attempt < 120; attempt++)); do
    grep -Fq '"focused":false' "$OVERLAY_STATE_FILE" && break
    sleep 0.1
  done
  grep -Fq '"focused":false' "$OVERLAY_STATE_FILE" || fail_with_frame 'The custom overlay did not become unfocused.'
  capture_frame
  printf '%s\n' "$FRAME" | grep -Fq 'Smoke custom overlay' || fail_with_frame 'Unfocusing the custom overlay hid it.'

  tmux send-keys -t "$SESSION" h
  for ((attempt = 0; attempt < 120; attempt++)); do
    grep -Fq '"hidden":true' "$OVERLAY_STATE_FILE" && break
    sleep 0.1
  done
  grep -Fq '"hidden":true' "$OVERLAY_STATE_FILE" || fail_with_frame 'The custom overlay did not become hidden.'
  for ((attempt = 0; attempt < 120; attempt++)); do
    capture_frame
    if ! printf '%s\n' "$FRAME" | grep -Fq 'Smoke custom overlay'; then
      break
    fi
    sleep 0.1
  done
  printf '%s\n' "$FRAME" | grep -Fq 'Smoke custom overlay' && fail_with_frame 'A hidden custom overlay remained visible.'
  printf '%s\n' "$FRAME" | grep -Fq 'Ask anything...' || fail_with_frame 'Hiding the custom overlay did not reveal the application.'

  tmux send-keys -t "$SESSION" h
  for ((attempt = 0; attempt < 120; attempt++)); do
    grep -Fq '"hidden":false' "$OVERLAY_STATE_FILE" && break
    sleep 0.1
  done
  grep -Fq '"hidden":false' "$OVERLAY_STATE_FILE" || fail_with_frame 'The custom overlay did not become visible again.'
  tmux send-keys -t "$SESSION" f
  for ((attempt = 0; attempt < 120; attempt++)); do
    grep -Fq '"focused":true' "$OVERLAY_STATE_FILE" && break
    sleep 0.1
  done
  grep -Fq '"focused":true' "$OVERLAY_STATE_FILE" || fail_with_frame 'The custom overlay did not regain focus.'

  tmux send-keys -t "$SESSION" Escape
  wait_for_file "$WORKSPACE/.smoke-editor-command-result"
  IFS= read -r EDITOR_RESULT < "$WORKSPACE/.smoke-editor-command-result" || true
  [[ "$EDITOR_RESULT" == 'undefined' ]] || fail_with_frame 'Escape did not dismiss the custom overlay.'
  wait_for_text 'Ask anything...' 150
  capture_frame
  printf '%s\n' "$FRAME" | grep -Fq 'Smoke custom overlay' && fail_with_frame 'The dismissed custom overlay remained visible.'
  tmux send-keys -l -t "$SESSION" 'overlay restoration draft'
  wait_for_text 'overlay restoration draft'
  tmux send-keys -t "$SESSION" C-c
  wait_for_text 'Ask anything...' 150

fi
  if [[ "$PACKED_PLUGIN_SMOKE" == 1 ]]; then
    tmux resize-window -t "$SESSION" -x 100 -y 30
    for phase in before-reload after-reload; do
      printf 'Checking independent Plugin overlay (%s).\n' "$phase"
      tmux send-keys -l -t "$SESSION" '/smoke-overlay'
      wait_for_text 'Open a standalone smoke overlay.' 150
      tmux send-keys -t "$SESSION" Tab
      tmux send-keys -t "$SESSION" Enter
      wait_for_text 'Independent Plugin overlay' 150
      tmux send-keys -t "$SESSION" x
      for ((attempt = 0; attempt < 120; attempt++)); do
        capture_frame
        if ! printf '%s\n' "$FRAME" | grep -Fq 'Independent Plugin overlay'; then
          break
        fi
        sleep 0.1
      done
      if printf '%s\n' "$FRAME" | grep -Fq 'Independent Plugin overlay'; then
        fail_with_frame "A Plugin overlay remained visible after dismissal ($phase)."
      fi
      if [[ "$phase" == before-reload ]]; then
        tmux send-keys -l -t "$SESSION" '/reload'
        tmux send-keys -t "$SESSION" Enter
        wait_for_text 'Reloaded keybindings, plugins' 150
      fi
    done
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
# The launcher records the child's status because tmux may leave its status unset.
EXIT_STATUS=""
if [[ -f "$TEST_HOME/.wincode-smoke-exit-status" ]]; then
  IFS= read -r EXIT_STATUS < "$TEST_HOME/.wincode-smoke-exit-status"
fi
if [[ "$EXIT_STATUS" != '0' ]]; then
  PANE_STATUS="$(tmux display-message -p -t "$SESSION" '#{pane_dead_status}')"
  EXIT_SIGNAL="$(tmux display-message -p -t "$SESSION" '#{pane_dead_signal}')"
  fail_with_frame \
    "TUI exited with status ${EXIT_STATUS:-unknown}${EXIT_SIGNAL:+ (signal $EXIT_SIGNAL)}; tmux status ${PANE_STATUS:-unknown}."
fi
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
elif [[ "$PACKED_PLUGIN_SMOKE" == 1 ]]; then
  printf 'PASS: installed CLI, explicit Plugin admission, Tool roundtrip, TSX overlay and reload.\n'
elif [[ "$PLUGIN_UI_SMOKE" == 1 ]]; then
  printf 'PASS: faux streaming, cancellation, tool roundtrip, error recovery, overlay resize/focus/visibility/dismissal/restoration, clean /exit.\n'
else
  printf 'PASS: faux streaming, cancellation, tool roundtrip, error recovery, resize, clean /exit.\n'
fi
