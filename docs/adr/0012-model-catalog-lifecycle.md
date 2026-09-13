# Model Catalog entries carry a lifecycle state

The Model Catalog is a curated product allowlist, not a mirror of what a
provider serves. Entries therefore carry `lifecycle: "active" | "retired"`.
The model picker and Agent pinning accept only `active` entries; retired
entries remain resolvable so existing Session Records keep their model label
and variant, and a turn attempting to send with a retired model is refused
with a visible prompt to pick another one.

Status: accepted

## Context

The persistence layer deliberately accepts model selections that are absent
from the catalog (`session-record.ts` validates only that `modelId` and
`providerId` are non-empty strings), while the read path resolves selections
through `normalizeChatModelSelection`, which drops any pair the catalog does
not know. Deleting an entry from `modelCatalog` therefore produced a silent
asymmetry: the stored row kept the model, message metadata lost it, and the
session fell back to the current default model without telling anyone. The
next turn ran on a different model than the history recorded.

This lifecycle rule applies when a product decision retires an entry while
preserving the corresponding Session Records. The 2026-09 catalog cleanup was
a separate, deliberate clean cutover: obsolete IDs were deleted after local
session data was reset, so those IDs were not converted into `retired` entries.
Future product retirements still use `lifecycle` when historical identity must
remain readable.

## Considered Options

- **Delete retired entries from `modelCatalog`** — cleanest array, but it
  converts "retired model is hidden" into "retired model is unlabelled", which
  is strictly worse and violates the restore semantics ADR-0006 established.
- **Keep a separate `retiredModelIds` list** — preserves the array, but splits
  one product fact across two declarations and gives the read path no variant
  or display-name data for retired models.
- **`lifecycle` on the entry (accepted)** — one source, one read path, and the
  same array serves selection, restore, and display.

## Consequences

- `lifecycle` is a property of the *definition*; runtime provenance
  (`source`, `stale`, `refreshedAt`) stays on the registry descriptor returned
  at read time. The two must not be merged.
- Selection predicates split in two: `normalizeChatModelSelection` (restore,
  lenient — accepts retired and returns the entry) and the send-path gate
  (strict — refuses retired with a typed reason).
- The picker filters `lifecycle === "active"`; the settings dialog keeps
  showing the current selection even when it is retired.
- Retiring an entry is not the same as the model disappearing upstream. When
  upstream drops a model that is still `active`, the metadata pipeline reports
  the gap rather than silently emitting a baseline-less entry.

## Explicit clean-cutover prune

The initial catalog prune deleted 27 obsolete OpenAI IDs. It followed the
reset of local session data and therefore did not create `retired` entries.
Later curation brought the catalog to 49 active entries: three Google Flash
models and 27 OpenCode Go models. The official Go endpoint table confirms
`longcat-2.0` uses OpenAI-compatible Chat Completions, while
`muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` use OpenAI
Responses. The current catalog has zero retired entries.

- **openai (deleted)** → `o1`, `o1-pro`, `o3`, `o3-mini`, `o3-pro`, `o4-mini`, `gpt-5`,
  `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`, `gpt-5-codex`, `gpt-5.1`,
  `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-chat-latest`, `gpt-5.2`,
  `gpt-5.2-codex`, `gpt-5.2-chat-latest`, `gpt-5.2-pro`, `gpt-5.3-codex`,
  `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`,
  `gpt-5.4-pro`, `gpt-5.5`, `gpt-5.5-pro`.
  Kept: `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- **anthropic** → no entries were deleted. Every current entry is Claude 4.5 or
  newer (`claude-haiku-4-5`, `claude-sonnet-4-5` and their dated aliases,
  `claude-opus-4-5`, `claude-opus-4-5-20251101`, `claude-opus-4-6`,
  `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-sonnet-5`,
  `claude-fable-5`).
- **google** and **opencode-go** were untouched by the initial OpenAI prune;
  their later curation is recorded above as a separate clean cutover.
