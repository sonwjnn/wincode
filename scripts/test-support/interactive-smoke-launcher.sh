#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
  WORKSPACE="$TEST_HOME/workspace"
  mkdir -p "$TEST_HOME/data" "$TEST_HOME/config" "$TEST_HOME/tmp" \
    "$WORKSPACE/.wincode"
  cp "$ROOT/scripts/test-support/interactive-smoke-wincode.json" \
    "$WORKSPACE/.wincode/settings.json"
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

PATH_VALUE="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
OS_USERNAME="${USER:-${LOGNAME:-$(id -un)}}"
(
  cd "$ROOT/packages/coding-agent"
  env -i \
    PATH="$PATH_VALUE" \
    HOME="$TEST_HOME" \
    USER="$OS_USERNAME" \
    LOGNAME="$OS_USERNAME" \
    TMPDIR="$TEST_HOME/tmp" \
    "$BUN_PATH" "$ROOT/scripts/test-support/prepare-interactive-smoke-provider.ts"
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
  TMPDIR="$TEST_HOME/tmp" \
  "$BUN_PATH" \
  "$ROOT/packages/coding-agent/bin/wincode.ts" \
  --trust-project \
  --plugin "$ROOT/packages/coding-agent/test/support/interactive-smoke-provider.ts"
