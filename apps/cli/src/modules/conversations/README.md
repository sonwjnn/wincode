# Conversations

Chat session lifecycle: creation, messaging, streaming display, and input handling.

## Flows

### Start a session
`HomeView` collects user input, creates a session via
`getConversationStore().createSession()` (local SQLite), then navigates to `/sessions/$id`
with the initial prompt in router state.

### Join a session
`ChatView` loads messages + metadata via `getConversationStore()` (`getMessages` +
`getSession`), validates the messages array with `safeValidateUIMessages`, and feeds them
into the AI SDK `useChat` hook.

### Send a message
`ChatView` accepts user text → `useChat.submit()` → `prepareSendChatRequestBody` serialises
the latest message + agent/model metadata + resolved file mentions → Hono transport → AI SDK
streams assistant response.

### Interrupt
Esc during streaming arms a confirmation timeout; second Esc fires `interrupt()` to stop
generation.

### Input overlays
`useChatInputController` detects `/` (command) and `@path` (file-mention) triggers as the
user types. The overlays are rendered by `CommandMenu` and `FileMentionMenu` above the
textarea. Arrow keys navigate; Enter selects and either executes a command or inserts a file
mention.

### Session management
`SessionsDialog` lists sessions via `getConversationStore().listSessions()`, supports tab
pin/unpin, delete. `RenameSessionDialog` patches the session title through the same store.

## Storage seam

`storage/` isolates conversation persistence behind the `ConversationStore` interface so the
UI never talks to a transport directly. Conversation persistence is local-only; the legacy
`legacy-remote-conversation-store.ts` Hono RPC adapter has been removed, so the files are flat
in `storage/` (no `local/` sub-folder).

- `conversation-store.ts` — `ConversationStore` interface + DTOs.
- `get-conversation-store.ts` — factory returning the local Drizzle store (cached singleton).
- `drizzle-conversation-store.ts` — `ConversationStore` implementation (the only store).
- `schema.ts` — SQLite Drizzle schema (`sqliteTable`, timestamp_ms, boolean, json modes).
- `path.ts` — platform-appropriate user-data DB path resolver (`conversations.db`, override
  with `WINCODE_LOCAL_DB_PATH`).
- `client.ts` — `bun:sqlite` connection with WAL / foreign-keys / busy-timeout pragmas +
  Drizzle instance.
- `migrations.ts` — runtime Drizzle migrator bootstrap (`drizzle/local` folder).

Local migrations are generated with `bun run db:local:generate` (config
`drizzle.local.config.ts`) and committed under `apps/cli/drizzle/local` with their `meta/`
snapshots. The local store runs the migrator on first open.

AI streaming flows through the server chat route as transport only: the CLI sends the full
message context with `persist: false`, the server never reads or writes PostgreSQL chat
tables for these streams, and finished messages are persisted locally via the `useChat`
`onFinish` callback (`getConversationStore().persistMessages`). `SERVER_URL` is required only
for streaming, not for local session CRUD.

## Public API

- `getConversationStore()` → `ConversationStore` (session CRUD, message load/persist)
- `useChat(sessionId, initialMessages)` → `{ submit, abort, interrupt,
  continueLastMessage, messages, status, error }`
- `useChatInputController(options)` → `{ actions, state }`
- `prepareSendChatRequestBody(sessionId, messages, metadata)` — constructs the send payload
- `ChatView`, `HomeView`, `ChatShell`, `ChatTextArea`
- `SessionsDialog`, `RenameSessionDialog`

## Dependencies

| Module | Used for |
| --- | --- |
| `modules/commands` | slash‑command specs, filtering, execution |
| `modules/file-mentions` | `@path` detection, options, resolution, overlay |
| `modules/connections` | provider auth + credential resolution for chat transport |
| `modules/prompt-settings` | `usePromptConfig` — current Agent/model |
| `shared/api` | Hono RPC client transport (chat stream only) |
| `shared/terminal/theme` | terminal colour tokens |
| `shared/terminal/keyboard-layer` | keyboard event stack |
| `shared/terminal/dialog` | dialog open/close/escape |
| `shared/terminal/toast` | transient status notifications |
