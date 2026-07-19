# Clipboard Image Paste Plan

## Goal

Allow users to paste images into the CLI prompt and send them as multimodal
message parts. Follow the simple OpenCode core flow first:

```text
paste image
  -> keep image in prompt memory
  -> show [Image N]
  -> create the session on submit when needed
  -> send an AI SDK file part containing a data URL
  -> persist the file part with the conversation
```

This phase does not write images to `.wincode/images`, route them through an
observer agent, or extend the `read` tool to handle binary files.

## Current State

- `ChatTextArea` owns uncontrolled OpenTUI textarea interaction and submits text
  only.
- `HomeView` creates a session only after the first prompt is submitted.
- `useChat` creates optimistic text-only user messages, resolves file mentions,
  and calls AI SDK `sendMessage`.
- `CodingAgentUIMessage` already permits standard AI SDK `file` parts.
- Conversation `partsJson` stores all UI message parts, so no database migration
  is required.
- Direct and hosted transports already forward complete UI messages.
- The current `read` tool reads UTF-8 text only and is not part of this feature.

## Reference Behavior

OpenCode core does not require a session ID when an image is pasted on Home. It
keeps the image as a data URL in prompt state. On submit, it creates the session,
sends the staged prompt parts under the new session ID, and navigates to the
session route.

The `.opencode/images/<sessionID>/...` behavior observed in the local OpenCode
setup comes from the installed `oh-my-opencode-slim` image hook, not the core
clipboard flow. Equivalent `.wincode/images` and observer routing are deferred.

## Scope

### Included

- Read clipboard images through OS-specific commands.
- Keep pending image bytes or data URLs in prompt memory.
- Render `[Image N]` attachment indicators.
- Allow image-only submissions.
- Send images as standard AI SDK `FileUIPart` values.
- Persist and restore image parts through the existing conversation store.
- Support both Home and existing-session prompts.
- Preserve existing text paste, commands, file mentions, and keyboard layers.
- Add size, count, MIME, and error handling limits.

### Excluded

- `.wincode/images` storage.
- Attachment cleanup tied to session deletion.
- Observer or subagent image routing.
- Binary support in the `read` tool.
- Drag-and-drop and file-picker attachments.
- Image previews inside the terminal.
- Provider-specific attachment branches.

## Message Shape

Each pasted image becomes a standard AI SDK file part:

```ts
{
	type: "file",
	mediaType: "image/png",
	filename: "clipboard",
	url: "data:image/png;base64,...",
}
```

The user message contains its text part, resolved file mention data parts, and
file parts for pasted images. `filename: "clipboard"` identifies the source in
the same lightweight way as OpenCode core. No custom attachment metadata is
needed in this phase.

## Implementation Plan

### 1. Clipboard Image Adapter

Add a conversations-owned clipboard adapter that returns image bytes and an IANA
media type when the system clipboard contains an image.

- macOS: use `osascript` to write PNG clipboard data to a unique temporary file,
  read it, and remove it in `finally`.
- Windows and WSL: use PowerShell clipboard APIs and normalize output to PNG.
- Linux Wayland: try `wl-paste -t image/png`.
- Linux X11: fall back to `xclip -selection clipboard -t image/png -o`.
- Use argument arrays rather than interpolated shell commands.
- Treat missing platform commands or non-image clipboard content as an expected
  unavailable result.
- Never log clipboard bytes or generated data URLs.

Keep this adapter inside `modules/conversations`; clipboard attachments are part
of prompt/conversation behavior and are not yet a proven shared abstraction.

### 2. Pending Prompt Attachments

Extend `ChatTextArea` with local pending image state. Each entry should contain a
stable ID, media type, filename, and data URL or bytes needed to construct one.

- Intercept the configured paste shortcut and query the clipboard adapter.
- Also accept an OpenTUI binary paste event when its metadata identifies an
  image.
- Do not prevent normal text paste unless an image was successfully captured.
- Keep images outside the uncontrolled textarea buffer.
- Render compact `[Image N]` indicators near the textarea.
- Enforce a maximum attachment count and per-image byte limit before adding an
  image.
- Surface expected failures through the existing toast UI.

Initial limits:

- Maximum 5 images per message.
- Maximum 10 MiB per image before base64 expansion.
- Accept image MIME types supported by the clipboard adapter; initial OS readers
  normalize to `image/png`.

### 3. Submission Contract

Replace the text-only callback with a prompt submission value:

```ts
type ChatPromptSubmission = {
	files: FileUIPart[];
	text: string;
};
```

- Update `ChatTextArea`, `ChatShell`, `HomeView`, and `ChatView` together.
- Permit submission when trimmed text is empty but at least one image exists.
- Preserve command and file-mention overlay behavior.
- Clear text and pending images after the submission is accepted, matching the
  current text submission behavior.
- Keep attachment state in the prompt while a command or file mention selection
  is being completed.

The input controller should receive the smallest additional signal needed to
allow attachment-only submission. It should not own image bytes or clipboard
I/O.

### 4. User Message Construction

Extend `createUserMessage` to accept standard file parts alongside file mention
parts.

- Preserve part ordering: text first, file mentions next, pasted files last.
- Reuse the helper from initial session creation and normal chat submission.
- Keep the optimistic message and the final `sendMessage` payload structurally
  consistent so the UI does not lose attachment indicators while file mentions
  are resolved.

### 5. Chat Submission

Update `useChat.submit` to accept prompt files.

- Add pasted files to the optimistic user message.
- Resolve file mentions as currently implemented.
- Call `chat.sendMessage` with text, resolved mention parts, and image file
  parts.
- On preparation failure, remove the optimistic message as today.
- Do not add provider-specific logic to the transport. Standard AI SDK file
  parts must flow through local and hosted routes unchanged.

### 6. Initial Session Creation

Keep Home session creation lazy.

- Pasting an image must not create a database session.
- Pending images remain in `ChatTextArea` memory.
- On submit, `HomeView` creates the first user message with text, file mentions,
  and image parts.
- The existing store creates the session and persists that message.
- Navigation continues with `autoStart: true`; the session route sends the
  already-persisted message to the model.

No draft session ID or temporary session directory is needed.

### 7. Message Rendering

Update user-message rendering to consume the complete user message rather than
only concatenated text.

- Continue rendering text and file mention badges with current styling.
- Count user `file` parts whose media type starts with `image/`.
- Render stable `[Image 1]`, `[Image 2]`, and subsequent indicators.
- Never render the data URL or base64 content.
- Restored messages should render the same indicators after restarting the CLI.

### 8. Persistence and Validation

Use the existing `partsJson` column; no migration is needed.

- Confirm `safeValidateUIMessages` accepts persisted standard file parts.
- Keep base64 data URLs inside `partsJson` for this phase.
- Ensure server-side message validation accepts the same file parts for hosted
  requests.
- Add no custom data schema unless implementation evidence shows it is needed.

## Error Behavior

- Non-image clipboard content: allow normal text paste behavior.
- Clipboard image extraction unavailable: show a concise warning and leave the
  prompt unchanged.
- Image exceeds limit: reject that image and preserve existing prompt content.
- Attachment count exceeds limit: reject only the new image.
- Provider rejects image input: surface the provider error through the existing
  chat error path.
- Failed message preparation: remove the optimistic message and retain current
  error behavior.

## Tests

### Clipboard Adapter

- macOS image extraction reads and removes the temporary file.
- Temporary file cleanup runs after command and read failures.
- Windows/WSL base64 output decodes to expected bytes.
- Wayland falls back correctly when unavailable.
- X11 image extraction returns PNG bytes.
- Missing commands and text-only clipboards return unavailable without leaking
  process errors.

### Prompt Input

- Image paste adds one pending attachment and renders `[Image 1]`.
- Multiple images receive stable ordering.
- Text paste remains textarea text.
- Image-only prompt can submit.
- Empty text with no images cannot submit.
- Count and byte limits reject only the new attachment.
- Successful submit clears text and attachments.
- Commands and file mention selection still work with pending images.

### Messages and Chat

- `createUserMessage` creates text, mention, and file parts in expected order.
- Optimistic and sent messages contain the same image parts.
- File mention resolution does not remove image parts.
- Direct transport receives image file parts.
- Hosted request construction preserves image file parts.
- Interrupted-message sanitization preserves valid user image parts.

### Persistence and Rendering

- Conversation store round-trips messages containing image file parts.
- Restored user messages render image indicators without exposing data URLs.
- Initial Home submission persists image parts before auto-starting the session.
- Existing-session submission persists image parts after completion.

## Verification

Run focused tests first, then project checks:

```bash
bun test packages/ai/src
bun test apps/cli/src
bun test apps/server/src
bun run --cwd packages/ai check-types
bun run --cwd apps/cli check-types
bun run --cwd apps/server check-types
bun run check
```

Manual smoke test with a vision-capable direct model and a hosted model:

1. Copy a screenshot to the system clipboard.
2. Paste it on Home and confirm `[Image 1]` appears without creating a session.
3. Submit an image-only prompt and confirm the model can describe the image.
4. Paste text and verify normal text paste remains unchanged.
5. Send text, a file mention, and multiple images in one prompt.
6. Restart the CLI and confirm image indicators remain in conversation history.

## Follow-Up Phase

If path-based routing becomes necessary, add it separately:

```text
submit
  -> session ID exists
  -> write .wincode/images/<sessionID>/...
  -> persist relative attachment references
  -> expand references into model file parts or delegate to an observer
```

That phase must define file lifecycle, orphan cleanup, session deletion behavior,
and hosted transport handling before replacing persisted data URLs.
