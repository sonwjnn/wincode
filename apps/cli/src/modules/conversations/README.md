# Conversations

Chat session lifecycle: creation, messaging, streaming display, compaction, and input handling.

## Flows

### Start a session

`HomeView` collects user input, creates a session through the local SQLite conversation store, then navigates to `/sessions/$id` with the initial prompt in router state.

### Join a session

`ChatView` loads the transcript and ordered local compaction entries, validates the messages, rebuilds active context, and feeds that context into the AI SDK `useChat` hook.

### Send a message

`ChatView` sends through the application-owned `ConversationOperation`. The operation delegates to the existing local AI SDK path, which resolves the current configured agent and direct model, hydrates local attachments, snapshots MCP tools, and streams the response.

### Interrupt

Esc during streaming arms a confirmation timeout; a second Esc calls `interrupt()` to stop generation.

### Compaction

`/compact [focus]` summarizes completed history into a durable local compaction entry while keeping the full transcript visible. Automatic threshold maintenance and one-attempt provider-overflow replay reuse the same local Conversation Compaction module.

### Input overlays

`useChatInputController` detects `/` command and `@path` file-mention triggers. `CommandMenu` and `FileMentionMenu` render the overlays and support keyboard selection.

### Session management

`SessionsDialog` lists local sessions, supports pin/unpin and deletion, and `RenameSessionDialog` updates titles through the same store.

## Storage seam

`storage/` isolates local persistence behind the `ConversationStore` interface. The local Drizzle store persists sessions, messages, compactions, and content-addressed attachment blobs.

- `conversation-store.ts` — store interface and DTOs.
- `get-conversation-store.ts` — cached local store factory.
- `drizzle-conversation-store.ts` — Drizzle SQLite implementation.
- `attachment-store.ts` — image blob storage, integrity-checked hydration, compaction projection, and garbage collection.
- `schema.ts` — SQLite schema and durable compaction/attachment records.
- `path.ts` — platform-specific local database and attachment paths.
- `migrations.ts` — local Drizzle migrator bootstrap.

Local migrations are generated with `bun run db:local:generate` and committed under `apps/cli/drizzle/local`. The store runs the migrator on first open.

## Public seams

- `getConversationStore()` — local sessions, messages, compactions, attachments, and maintenance.
- `ConversationOperation` — one application-owned send, cancellation, and interruption seam for the current turn path.
- `useChat(sessionId, initialMessages)` — conversation state, operation wiring, compaction, messages, status, and errors.
- `useChatInputController(options)` — command and file-mention input state.
- `ChatView`, `HomeView`, `ChatShell`, `ChatTextArea` — conversation UI.
- `SessionsDialog`, `RenameSessionDialog` — session management UI.

## Dependencies

| Module | Used for |
| --- | --- |
| `modules/commands` | slash-command specs, filtering, and execution |
| `modules/file-mentions` | `@path` detection and resolution |
| `modules/connections` | direct provider credentials |
| `modules/prompt-settings` | current agent and model |
| `modules/mcp` | local MCP snapshots and tool dispatch |
| `shared/providers` | terminal theme, keyboard, dialogs, and toast state |
