# File Mention Findings

## Context

Wincode currently uses two different message-part types for two different jobs:

- `FileUIPart` represents provider-consumable attachments such as pasted images.
- `data-fileMention` represents bounded workspace context resolved from `@path`
  references.

This separation is appropriate. A workspace mention carries application semantics
such as path, file or directory kind, truncation, byte length, and resolution
errors. `FileUIPart` only describes an attachment URL, media type, and optional
filename, and provider support for text files is not consistent.

The main concerns are therefore not about replacing `data-fileMention` with
`FileUIPart`. They are about keeping conversion, restoration, rendering,
persistence, and trust boundaries consistent.

## Current Flow

```text
user types @src/example.ts
  -> CLI resolves workspace path
  -> CLI reads bounded file content
  -> UI message receives data-fileMention
  -> transport expands data-fileMention into model-visible text
  -> model processes text context
  -> application restores original data-fileMention for UI/persistence
```

Images follow a separate path:

```text
paste image
  -> CLI creates FileUIPart with a data URL
  -> provider receives a standard file attachment
  -> UI persists and renders the attachment indicator
```

## Findings

### 1. Local and hosted flows are not clearly symmetric

**Evidence**

- `apps/cli/src/modules/conversations/hooks/local-chat-transport.ts:50`
- `packages/ai/src/server/stream.ts:41`
- `packages/ai/src/server/stream.ts:47`

The direct transport expands file mentions before creating the stream:

```ts
const modelMessages = expandFileMentionPartsForModel(messages);
```

It then supplies the expanded messages as both model and UI input. The hosted
flow instead retains the original UI messages while expanding a separate model
representation, allowing `restoreOriginalFileMentionParts` to map model messages
back to the original custom parts.

This creates a behavioral asymmetry:

```text
hosted: original custom part -> expanded text -> restored custom part
direct: original custom part -> expanded text -> original mapping may be lost
```

**Impact**

- Direct and hosted conversations may persist different part shapes.
- A direct response may retain synthetic mention context instead of the original
  `data-fileMention` part.
- Bugs may appear only for one model route.

**Recommendation**

Use one shared stream boundary that always receives both:

- Original `CodingAgentUIMessage[]` for UI state and restoration.
- Expanded model messages for provider input.

Add parity tests that send the same mention through direct and hosted transports
and compare the persisted user-message parts.

### 2. Restoration relies on fragile full-part equality

**Evidence**

- `packages/ai/src/file-mentions.ts:104`
- `packages/ai/src/file-mentions.ts:109`

Restoration currently compares complete part arrays using `JSON.stringify`:

```ts
JSON.stringify(left.parts) === JSON.stringify(right.parts)
```

This assumes the AI SDK returns every expanded part with identical ordering,
metadata, and serialization. Harmless SDK changes can break that assumption.

**Impact**

- Added provider metadata may prevent restoration.
- Streaming or continuation changes may prevent restoration.
- Unknown custom parts are silently dropped by the fallback whitelist.
- Comparison cost grows with embedded source content.

**Recommendation**

Give each file mention a stable part ID and restore by message ID plus part ID.
Keep an explicit mapping from the generated model text part to the original
`data-fileMention` part. Do not use full-message JSON equality as identity.

### 3. UI derives mentions from text instead of data parts

**Evidence**

- `apps/cli/src/modules/conversations/ui/messages/user-message.tsx`
- `apps/cli/src/modules/file-mentions/utils/mention-grammar.ts`

The user-message renderer reparses `@path` tokens from the text part. It does not
use resolved `data-fileMention` parts as its primary source.

**Impact**

- The displayed path may differ from the normalized resolved path.
- Resolution failures are invisible.
- Truncation status is invisible.
- File and directory metadata come from syntax rather than validated data.
- Message rendering can disagree with the context actually sent to the model.

**Recommendation**

Render mention badges from `data-fileMention` parts. Keep text parsing only as a
fallback for legacy messages that have mention text but no custom parts.

Useful UI states include:

- File or directory kind.
- Normalized path.
- Truncated indicator.
- Resolution-error indicator without exposing sensitive error details.

### 4. Persistence stores complete source snapshots

**Evidence**

- `apps/cli/src/modules/file-mentions/utils/resolve-file-mention-parts.ts`
- `apps/cli/src/modules/conversations/storage/drizzle-conversation-store.ts:173`

Resolved source content is embedded in `data-fileMention` and persisted in the
message `partsJson` column.

**Benefits**

- Replaying a conversation uses the original source snapshot.
- The conversation remains understandable after the workspace file changes.
- Model context is deterministic across retries.

**Risks**

- SQLite size grows with repeated mentions.
- Deleted source content remains in conversation history.
- Secrets may be copied into local conversation storage.
- Every hosted request may retransmit old source snapshots in full history.

**Recommendation**

Choose and document one persistence policy:

1. Persist snapshots intentionally, with explicit retention and user-visible
   privacy behavior.
2. Persist metadata only and re-resolve content before each model request.
3. Persist bounded/redacted snapshots and optionally deduplicate content by hash.

Until a policy is chosen, retain the existing byte limits and avoid increasing
them. Consider warnings or deny rules for common secret files.

### 5. Hosted server trusts CLI-provided workspace content

**Evidence**

- `apps/server/src/routes/sessions.ts:180`
- `packages/ai/src/file-mentions.ts:6`

The hosted route validates the shape of `data-fileMention`, but it cannot verify
that the supplied path and content came from the caller's workspace. The server
has no access to that local filesystem.

This is not automatically a vulnerability. User messages are inherently
untrusted model input. It is, however, an important trust boundary.

**Impact**

- `path`, `kind`, `byteLength`, and `content` are client assertions.
- Server logs or analytics must never treat mention metadata as verified facts.
- Authorization to use hosted chat does not prove workspace ownership.

**Recommendation**

- Treat mention data as untrusted prompt content.
- Enforce server-side request, part-count, and content-size limits.
- Never use mention paths for server filesystem access.
- Never interpolate mention metadata into shell commands or privileged actions.
- Avoid logging source content.
- Name schemas and variables to communicate that data is client supplied.

### 6. Mention grammar does not fully match filesystem names

**Evidence**

- `apps/cli/src/modules/file-mentions/utils/mention-grammar.ts`

The grammar uses syntax rules that do not represent every valid filesystem path.
Unicode names, whitespace, quoting, and punctuation can be ambiguous or
unsupported.

**Impact**

- Valid files may not be mentionable.
- The visible token may resolve to a different normalized path.
- Email addresses and punctuation require special disambiguation.

**Recommendation**

Define mention syntax independently from filesystem syntax. Prefer an explicit
selection token generated by the file-mention menu rather than trying to parse
every possible raw path.

Potential direction:

```text
@simple/path.ts
@"path with spaces.ts"
@"Unicode/du-lieu.ts"
```

Add tests for Unicode, spaces, quotes, punctuation, directories, email-like text,
and Windows separators if Windows workspace support is required.

## Recommended Priority

### P0: Transport correctness

1. Make direct and hosted expansion/restoration symmetric.
2. Add route-parity persistence tests.

### P1: Stable restoration

1. Add stable IDs to mention parts.
2. Replace `JSON.stringify` equality with explicit part mapping.

### P2: Rendering and observability

1. Render from `data-fileMention`.
2. Expose safe error and truncation states.
3. Retain text parsing only for legacy messages.

### P3: Persistence and privacy policy

1. Decide whether source snapshots are durable conversation data.
2. Add retention, redaction, or metadata-only behavior as required.

### P4: Grammar coverage

1. Specify quoting and Unicode behavior.
2. Add filesystem edge-case tests.

## Target Architecture

```text
UI message
  text part: visible prompt text
  data-fileMention: validated UI/domain metadata + bounded snapshot
  FileUIPart: provider-consumable binary/media attachment

shared conversion boundary
  original UI messages
    -> model messages with mention context expanded to text
    -> provider execution
    -> restore custom parts by stable identity

persistence
  stores original UI message representation
  never stores transport-expanded synthetic parts
```

The key invariant is:

> Model conversion may change the provider-facing representation, but it must
> not change the canonical UI message persisted by the CLI.
