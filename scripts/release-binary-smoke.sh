#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" || "$1" != /* ]]; then
  printf 'Usage: %s /absolute/path/to/wincode\n' "$0" >&2
  exit 2
fi
BINARY="$1"
BINARY="$(cd "$(dirname "$BINARY")" && pwd -P)/$(basename "$BINARY")"
USER_NAME="${USER:-${USERNAME:-wincode-release-smoke}}"
umask 077
TEST_HOME="$(mktemp -d)"
cleanup() {
  local status=$?
  rm -rf "$TEST_HOME"
  return "$status"
}
trap cleanup EXIT
mkdir -p \
  "$TEST_HOME/home" \
  "$TEST_HOME/data" \
  "$TEST_HOME/config" \
  "$TEST_HOME/cache" \
  "$TEST_HOME/tmp" \
  "$TEST_HOME/workspace"

ISOLATED_ENV=(
  "PATH=$PATH"
  "HOME=$TEST_HOME/home"
  "USER=$USER_NAME"
  "LOGNAME=$USER_NAME"
  "USERPROFILE=$TEST_HOME/home"
  "XDG_DATA_HOME=$TEST_HOME/data"
  "XDG_CONFIG_HOME=$TEST_HOME/config"
  "XDG_CACHE_HOME=$TEST_HOME/cache"
  "APPDATA=$TEST_HOME/appdata"
  "LOCALAPPDATA=$TEST_HOME/localappdata"
  "TMPDIR=$TEST_HOME/tmp"
  "TEMP=$TEST_HOME/tmp"
  "TMP=$TEST_HOME/tmp"
  "WINCODE_TEST_SESSION_INDEX_DIR=$TEST_HOME/session-indexes"
  "NODE_ENV=test"
)
if [[ -n "${SYSTEMROOT:-}" ]]; then
  ISOLATED_ENV+=(
    "SYSTEMROOT=$SYSTEMROOT"
    "WINDIR=${WINDIR:-$SYSTEMROOT}"
    "COMSPEC=${COMSPEC:-$SYSTEMROOT\System32\cmd.exe}"
  )
fi
run_isolated() {
  (
    cd "$TEST_HOME/workspace"
    env -i "${ISOLATED_ENV[@]}" "$BINARY" "$@"
  )
}

if ! run_isolated --help >"$TEST_HOME/help.txt" 2>"$TEST_HOME/help.err"; then
  printf 'FAIL: compiled Wincode --help did not exit successfully.\n' >&2
  cat "$TEST_HOME/help.err" >&2
  exit 1
fi
grep -Fq 'Usage: wincode [options]' "$TEST_HOME/help.txt" || {
  printf 'FAIL: compiled Wincode --help did not print its usage.\n' >&2
  cat "$TEST_HOME/help.txt" >&2
  exit 1
}
[[ ! -s "$TEST_HOME/help.err" ]] || {
  printf 'FAIL: compiled Wincode --help wrote to stderr.\n' >&2
  cat "$TEST_HOME/help.err" >&2
  exit 1
}

if ! run_isolated --version >"$TEST_HOME/version.txt" 2>"$TEST_HOME/version.err"; then
  printf 'FAIL: compiled Wincode --version did not exit successfully.\n' >&2
  cat "$TEST_HOME/version.err" >&2
  exit 1
fi
VERSION="$(tr -d '\r\n' < "$TEST_HOME/version.txt")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][[:alnum:].-]+)?$ ]] || {
  printf 'FAIL: compiled Wincode returned an invalid version: %s\n' "$VERSION" >&2
  exit 1
}
[[ ! -s "$TEST_HOME/version.err" ]] || {
  printf 'FAIL: compiled Wincode --version wrote to stderr.\n' >&2
  cat "$TEST_HOME/version.err" >&2
  exit 1
}

printf 'PASS: compiled Wincode %s --help and --version in isolated user data.\n' "$VERSION"
