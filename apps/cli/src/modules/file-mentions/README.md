# File Mentions

Resolves `@path` mentions typed in the chat input into workspace file data
for AI context.

## Flows

1. **Detection** — `detectFileMentionAtCursor` recognises a live `@path` pattern while the user
   types, returning range and query boundary.
2. **Options** — `getFileMentionOptions` asynchronously indexes every eligible workspace entry
   once for the input lifecycle; it applies fixed ignored-directory, `.gitignore`, and symlink
   policy through the workspace sandbox. `filterFileMentionOptions` ranks the in-memory options by
   exact basename or extensionless stem, basename prefix, basename contains, path segment, and
   subsequence matches. Slash-containing queries retain their relative path context. Results are
   sorted deterministically before the existing 100-option limit is applied.
3. **Overlay** — `FileMentionMenu` renders the active suggestion list inside the chat input
   area. Keyboard events cycle selection; Enter applies the chosen mention.
4. **Replacement** — `applyFileMentionReplacement` inserts the selected label into the
   textarea, replacing the raw trigger text. `deleteFileMentionAfterTrailingCharacterDelete`
   handles backspace-to-remove behaviour.
5. **Resolution** — `resolveFileMentionParts` first resolves the exact literal path inside the
   workspace, even when that path is `.gitignore`-ignored. A bare token can fall back only to one
   discovered exact basename or extensionless-stem file; ignored files therefore do not participate
   in fallback. Ambiguous matches return bounded canonical candidates and fuzzy matches never attach
   silently. Resolved parts use canonical workspace-relative POSIX paths and retain existing file,
   directory, binary, and aggregate-byte limits.

## Public API

- `findFileMentionRanges`, `detectFileMentionAtCursor`, `normalizeFileMentionPath`
- `applyFileMentionReplacement`, `deleteFileMentionAfterTrailingCharacterDelete`
- `getFileMentionOptions`, `filterFileMentionOptions`
- `resolveFileMentionParts`
- `FileMentionMenu`
- `FileMentionOption`, `FileMentionRange`, `FileMentionReplacement`

## Dependencies

- `@wincode/ai` — `FileMentionUIPart`
- `@wincode/ai/workspace` — `createWorkspaceSandbox`, `traverseWorkspaceEntries`
- `shared/terminal/theme` — terminal colour context
