# Conversations

Chat session lifecycle: creation, messaging, streaming display, and input handling.

## Flows

### Start a session
`HomeView` collects user input, calls `POST /api/sessions` via Hono RPC, then navigates to
`/sessions/$id` with the initial prompt in router state.

### Join a session
`ChatView` loads `GET /api/sessions/:id` + `GET /api/sessions/:id/messages` on mount,
validates the messages array with `safeValidateUIMessages`, and feeds them into the AI SDK
`useChat` hook.

### Send a message
`ChatView` accepts user text → `useChat.submit()` → `prepareSendChatRequestBody` serialises
the latest message + mode/model metadata + resolved file mentions → Hono transport → AI SDK
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
`SessionsDialog` lists sessions via `GET /api/sessions`, supports tab pin/unpin, delete.
`RenameSessionDialog` patches the session title.

## Public API

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
| `modules/prompt-settings` | `usePromptConfig` — current mode/model |
| `shared/api` | Hono RPC client transport |
| `shared/terminal/theme` | terminal colour tokens |
| `shared/terminal/keyboard-layer` | keyboard event stack |
| `shared/terminal/dialog` | dialog open/close/escape |
| `shared/terminal/toast` | transient status notifications |
