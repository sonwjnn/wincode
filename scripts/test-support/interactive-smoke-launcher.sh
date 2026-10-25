#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "${WINCODE_SMOKE_LIVE:-0}" == 1 && "${WINCODE_SMOKE_APPROVED:-0}" != 1 ]]; then
  printf 'Live smoke launcher requires explicit billable approval.\n' >&2
  exit 1
fi
umask 077
MANAGED_HOME=0
if [[ -n "${WINCODE_SMOKE_HOME:-}" && -n "${WINCODE_SMOKE_BUN:-}" ]]; then
  TEST_HOME="$WINCODE_SMOKE_HOME"
  BUN_PATH="$WINCODE_SMOKE_BUN"
else
  if ! command -v bun >/dev/null 2>&1; then
    printf 'bun is required for the interactive smoke.\n' >&2
    exit 1
  fi
  BUN_PATH="$(command -v bun)"
  TEST_HOME="$(mktemp -d)"
  TEST_HOME="$(cd "$TEST_HOME" && pwd -P)"
  WORKSPACE="$TEST_HOME/workspace"
  mkdir -p "$TEST_HOME/data" "$TEST_HOME/config" "$TEST_HOME/tmp" \
    "$WORKSPACE/.wincode"
  cp "$ROOT/scripts/test-support/interactive-smoke-wincode.json" \
    "$WORKSPACE/.wincode/settings.json"
  printf 'smoke-file-content\n' > "$WORKSPACE/smoke-fixture.txt"
  cd "$WORKSPACE"
  MANAGED_HOME=1
fi

cleanup() {
  if [[ "$MANAGED_HOME" == '1' ]]; then
    rm -rf "$TEST_HOME"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

WORKSPACE="$PWD"
PATH_VALUE="$(dirname "$BUN_PATH"):/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
PREPARE="$ROOT/scripts/test-support/prepare-interactive-smoke-provider.ts"
COMMAND=("$BUN_PATH" --no-env-file "$ROOT/packages/coding-agent/bin/wincode.ts")
if [[ -n "${WINCODE_SMOKE_BINARY:-}" ]]; then
  COMMAND=("$WINCODE_SMOKE_BINARY")
fi
PLUGIN_ARGS=(--plugin "${WINCODE_SMOKE_PLUGIN:-$ROOT/packages/coding-agent/test/support/interactive-smoke-provider.ts}")
if [[ "${WINCODE_SMOKE_LIVE:-0}" == 1 ]]; then
  PREPARE="$ROOT/scripts/test-support/prepare-live-smoke.ts"
  PLUGIN_ARGS=()
fi
OS_USERNAME="${USER:-${LOGNAME:-$(id -un)}}"
(
  cd "$ROOT/packages/coding-agent"
  env -i \
    PATH="$PATH_VALUE" \
    HOME="$TEST_HOME" \
    USER="$OS_USERNAME" \
    LOGNAME="$OS_USERNAME" \
    TMPDIR="$TEST_HOME/tmp" \
    XDG_DATA_HOME="$TEST_HOME/data" \
    APPDATA="$TEST_HOME/appdata" \
    WINCODE_SMOKE_MODEL="${WINCODE_SMOKE_MODEL:-}" \
    WINCODE_SMOKE_WORKSPACE="$WORKSPACE" \
    WINCODE_SMOKE_HOME="$TEST_HOME" \
    "$BUN_PATH" --no-env-file "$PREPARE"
)
env -i \
  PATH="$PATH_VALUE" \
  USER="$OS_USERNAME" \
  LOGNAME="$OS_USERNAME" \
  TERM="${TERM:-screen-256color}" \
  LANG="${LANG:-C.UTF-8}" \
  TERM_PROGRAM="${TERM_PROGRAM:-tmux}" \
  COLORTERM="${COLORTERM:-}" \
  TMUX="${TMUX:-}" \
  TMUX_PANE="${TMUX_PANE:-}" \
  HOME="$TEST_HOME" \
  XDG_DATA_HOME="$TEST_HOME/data" \
  XDG_CONFIG_HOME="$TEST_HOME/config" \
  XDG_CACHE_HOME="$TEST_HOME/cache" \
  NODE_ENV=test \
  WINCODE_TEST_SESSION_INDEX_DIR="$TEST_HOME/session-indexes" \
  TMPDIR="$TEST_HOME/tmp" \
  "${COMMAND[@]}" \
  --trust-project \
  ${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"}
