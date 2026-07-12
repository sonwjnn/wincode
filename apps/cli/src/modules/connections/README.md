# Connections

Provider credential storage for CLI connections.

## Providers

- `wincode`: OAuth session or API key
- `openai`: API key
- `anthropic`: API key

## Connection APIs

- `connectProvider(...)` validates API keys before storage replace
- OpenAI validation: `GET https://api.openai.com/v1/models` with `Authorization: Bearer <key>`
- Anthropic validation: `GET https://api.anthropic.com/v1/models` with `x-api-key` + `anthropic-version: 2023-06-01`
- Wincode API key validation: injected callback only; default throws unavailable error
- `connectWincodeBrowser(...)` owns browser OAuth PKCE flow and stores credential only after token exchange
- `migrateLegacyWincodeSession(...)` migrates legacy reader output when destination empty; no auto-run

## Storage

- Primary: `Bun.secrets` via service `wincode` / account `connections`
- Fallback: `~/.wincode/connections.json` only when `Bun.secrets` is unavailable
- Auto selects Bun only when both `get` + `set` exist; partial Bun secret API -> file fallback
- Test seam: `backendMode: "file"` or injected `bunSecrets`

Fallback file rules:

- parent dir `0700`
- file `0600`
- atomic temp write + rename
- reject non-regular target files and symlinks
- validate existing file/dir permissions before use; POSIX only
- legacy session migration is write + read-back verified, never deletes source
