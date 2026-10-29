#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Relative PATH entries belong to the caller, not the checkout we enter below.
SEARCH_PATH="$PATH:"
NORMALIZED_PATH=""
while [[ "$SEARCH_PATH" == *:* ]]; do
  ENTRY="${SEARCH_PATH%%:*}"
  SEARCH_PATH="${SEARCH_PATH#*:}"
  case "$ENTRY" in
    /*) ;;
    *) ENTRY="$PWD/${ENTRY:-.}" ;;
  esac
  NORMALIZED_PATH="${NORMALIZED_PATH:+$NORMALIZED_PATH:}$ENTRY"
done
export PATH="$NORMALIZED_PATH"
if ! command -v bun >/dev/null 2>&1; then
  printf 'bun is required. Install dependencies before running ./test.sh.\n' >&2
  exit 127
fi
BUN_PATH="$(command -v bun)"
OS_USERNAME="${USER:-${LOGNAME:-$(id -un)}}"
umask 077
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wincode-tests.XXXXXX")"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"

mkdir -p "$TEST_ROOT/home" "$TEST_ROOT/config" "$TEST_ROOT/data" \
  "$TEST_ROOT/cache" "$TEST_ROOT/tmp"
ENVIRONMENT=(
  "PATH=$PATH"
  "HOME=$TEST_ROOT/home"
  "USER=$OS_USERNAME"
  "LOGNAME=$OS_USERNAME"
  "NODE_ENV=test"
  "WINCODE_TEST_SESSION_INDEX_DIR=$TEST_ROOT/session-indexes"
  "XDG_CONFIG_HOME=$TEST_ROOT/config"
  "XDG_DATA_HOME=$TEST_ROOT/data"
  "XDG_CACHE_HOME=$TEST_ROOT/cache"
  "APPDATA=$TEST_ROOT/data"
  "LOCALAPPDATA=$TEST_ROOT/cache"
  "TMPDIR=$TEST_ROOT/tmp"
  "TMP=$TEST_ROOT/tmp"
  "TEMP=$TEST_ROOT/tmp"
  "LANG=${LANG:-C.UTF-8}"
  "TERM=${TERM:-dumb}"
)
if [[ -n "${CI+x}" ]]; then
  ENVIRONMENT+=("CI=$CI")
fi

cd "$ROOT"
env -i "${ENVIRONMENT[@]}" "$BUN_PATH" --no-env-file run test "$@"
