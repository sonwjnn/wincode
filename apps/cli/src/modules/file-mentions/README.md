# File Mentions

Resolves `@path` mentions typed in the chat input into workspace file data
for AI context.

## Flows

1. **Detection** — `detectFileMentionAtCursor` recognises a live `@path` pattern while the user
   types, returning range and query boundary.
2. **Options** — `getFileMentionOptions` traverses the workspace filesystem producing a flat
   `FileMentionOption[]`; `filterFileMentionOptions` narrows it by partial query.
3. **Overlay** — `FileMentionMenu` renders the active suggestion list inside the chat input
   area. Keyboard events cycle selection; Enter applies the chosen mention.
4. **Replacement** — `applyFileMentionReplacement` inserts the selected label into the
   textarea, replacing the raw trigger text. `deleteFileMentionAfterTrailingCharacterDelete`
   handles backspace-to-remove behaviour.
5. **Resolution** — `resolveFileMentionParts` scans the finished message text for mention
   ranges, normalises paths, reads workspace files within safety bounds, and returns
   `FileMentionUIPart[]` ready for the AI SDK submit payload.

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
