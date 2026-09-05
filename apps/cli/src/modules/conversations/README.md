# Conversations

Chat session lifecycle: creation, messaging, streaming display, compaction, and input handling.

## Flows

### Start a session

`ChatView` in home mode collects user input and writes the accepted user
message as an ordinary durable Conversation Record in the local SQLite store.
It then navigates to `/sessions/$id` with transient startup state. That state
starts the first Agent Turn once; opening the same session later only restores
durable records and never runs the Agent.
### Join a session

`ChatView` loads the transcript and ordered local compaction entries, validates the messages, rebuilds active context, and gives that context to the Wincode `ConversationController`.

### Send a message

`ChatView` sends through the application-owned `ConversationController`. The
controller owns the submit, cancellation, interruption, state subscription,
approval-response contracts, and the single Agent Runtime event consumer. The
CLI projects those events into its OpenTUI message state.

The accepted user message is committed before runtime execution begins. Each
completed Tool Call is committed as its own ordinary tool record, and terminal
assistant text is committed as an assistant record. Token and reasoning deltas
remain transient. Failed and cancelled turns commit a safe assistant message;
partial provider output is not durable. Retry is an explicit user action and
reuses the original logical user message without appending a duplicate.

### Compaction

`/compact [focus]` summarizes completed history into a durable local compaction entry while keeping the full transcript visible. Automatic threshold maintenance and one-attempt provider-overflow replay reuse the same local Conversation Compaction module.

### Input overlays

`useChatInputController` detects `/` command and `@path` file-mention triggers. `CommandMenu` and `FileMentionMenu` render the overlays and support keyboard selection.

### Session management

`SessionsDialog` lists local sessions, supports pin/unpin and deletion, and `RenameSessionDialog` updates titles through the same store.

## Storage seam

`storage/` isolates local persistence behind the `ConversationStore` interface.
The local Drizzle store persists sessions, ordinary Wincode Conversation
Records, compactions, and content-addressed attachment blobs. Each
`conversation_record` row contains one durable user, assistant, or completed
Tool Call message, its semantic outcome, model selection, and live turn
correlation. Primary and delegated rows retain their selection and delegation
metadata; delegated rows remain presentation-identifiable.

Rows are append-only checkpoints. Reopening a session projects primary rows in
storage order and keeps delegated rows grouped after the primary transcript,
then rebuilds model context from successful history and completed Tool Calls.
No execution lifecycle state is persisted, and startup does not reconstruct or
replay an Agent Turn.

TODO(issue-86): define richer durable interrupted-turn metadata only with an
explicit resume/retry contract. Until then, interrupted output is represented
by the safe assistant outcome and retry remains explicit.
TODO(issue-86): design queued execution for busy sessions separately; busy
submissions remain rejected in this lifecycle.
TODO(issue-86): define an explicit retrying runtime state only if retries need
distinct live status from the current Agent Turn.


- `conversation-store.ts` — store interface and DTOs.
- `get-conversation-store.ts` — cached local store factory.
- `drizzle-conversation-store.ts` — Drizzle SQLite implementation.
- `conversation-record.ts` — record validation and CLI presentation projection.
- `attachment-store.ts` — image blob storage, integrity-checked hydration, compaction projection, and garbage collection.
- `schema.ts` — SQLite schema and durable Conversation Record/compaction/attachment tables.
- `path.ts` — platform-specific local database and attachment paths.
- `migrations.ts` — local Drizzle migrator bootstrap.

Local migrations are generated with `bun run db:local:generate` and committed under `apps/cli/drizzle/local`. The store runs the migrator on first open.

This is a breaking local persistence cutover. Existing development databases
must be cleared manually; no migration or automatic cleanup converts prior
execution-state rows.

- `getConversationStore()` — local sessions, Conversation Records, compactions, attachments, and maintenance.
- `ConversationOperation` — one application-owned send, cancellation, and interruption seam for the current turn path.
- `useChat(sessionId, initialMessages)` — CLI-owned conversation state, runtime event projection, compaction, and errors.
- `useChatInputController(options)` — command and file-mention input state.
- `ChatView`, `ChatShell`, `ChatTextArea` — conversation UI.
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
