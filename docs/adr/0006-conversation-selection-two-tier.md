# Conversation Selection Records Two Tiers

The conversation-selection read path merges two intentionally distinct sources:
the session row records the **conversation-level choice** — the user's explicit
Agent, model, and variant in the prompt config at the last persist — while
message metadata records the **effective selection** — what a turn actually ran
with, including Agent pins that override the choice. The merge order (session
row, then message metadata, then prompt-config refs) is the single policy,
owned by the conversation-selection module and exercised by chat-view,
home-view, and the routing transport alike.

Status: accepted

## Considered Options

- **Two-tier write (accepted)** - `submit` and `continueLastMessage` carry the
  effective selection (`modelRef`/`variantRef`) and the conversation-level
  choice (`conversationModelRef`/`conversationVariantRef`) as separate values.
  Persists write the choice to the session row and the effective selection to
  message metadata. A user who explicitly picks `low` while an Agent pins
  `high` for one turn keeps `low` as the conversation choice: a new chat from
  home or a reopened session restores the choice, and the transport still sends
  the effective selection for the pinned turn.
- **Single written value** - persist the effective selection to the session row
  and delete `conversationModelRef`/`conversationVariantRef` and the
  `conversationModel`/`conversationVariant` parameters. Removes the divergence
  class entirely, but loses the choice tier: after one Agent-pinned turn, the
  row records the pinned value and a new chat restores it as if the user had
  chosen it. Variant and model are user preferences; an Agent pin is per-Agent,
  not a conversation preference, so the collapse regresses restore semantics.
- **Drop the session-row variant column** - readers already load messages on
  open (the session route fetches both in parallel), so restore could read
  metadata only. Same regression as the single written value, plus a schema
  migration for no behavioral gain.

## Consequences

- The write side keeps two values; the divergence between them is load-bearing
  (choice vs effective) rather than a bug to eliminate.
- The bug that motivated this investigation — a persisted user message dropping
  an undefined variant at the JSON round trip, so restore lost the last-used
  variant — was a read-side gap: the merge ignored message metadata whenever
  the session row carried a model. It is closed by the scan-back and the
  centralized precedence, not by unifying the write side.
- Future restore paths must route through the conversation-selection merge
  (session row, then message metadata, then prompt-config refs) instead of
  re-deriving precedence, or they re-open the divergence class this ADR closes.
- The session-row model additionally feeds recent-model selection history;
  dropping the column would cost that reader too.
