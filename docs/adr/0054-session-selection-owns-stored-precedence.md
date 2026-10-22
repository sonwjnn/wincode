# Session Selection owns stored precedence

Status: accepted

The precedence between a Session's recorded selection tiers was implemented at
each caller that needed it. The session row, the newest message pair, and the
prompt-config refs were merged inside the Host, re-merged with an extra refs
tier inside the Interactive surface, and merged a third time inside One-Shot
Mode, which carried five private resolvers for the same three values. The
surface also re-derived the restore guard — whether the restored Model still
matches the selected Agent's pin — on top of its own read. The module exported
seven resolvers, one of which (`resolveOutgoingSelection`) had no caller at all.

Every copy agreed on the Model order but not on the rest: Agent never had a
session-row tier, and the next-chat default deliberately drops row and refs
whenever the newest message carries a complete pair. `GLOSSARY.md` described a
single ladder that no implementation used.

## Decision

- `restoreSelection(material)` in `modules/sessions/selection.ts` is the only
  order table for stored tiers. It merges the session row, then message
  metadata, then prompt-config refs, and reports the tier that supplied the
  Model as `source`, so a caller can tell a restored choice from a ref it passed
  in. It returns nothing when no tier carries a Model.
- Precedence is per value, not one ladder. Agent has no session-row tier and
  merges message metadata, then refs. `nextChatSelection` is the narrower
  next-chat variant that reads the newest complete message pair alone; it shares
  the same tiers rather than a second table.
- Defaults are a separate question. `sessionSelectionDefaults(registry,
  options)` resolves a Session that never recorded a choice, and each mode
  composes defaults with a restore in the order it needs: the Host asks only
  what was recorded, while One-Shot Mode prefers an explicit flag, then the
  Host's restore, then the defaults. Defaults are not a restore tier, because
  composing them as one would let a default outrank a caller's prompt-config
  ref.
- `restorableSelectionModel(selection, pinnedModel)` owns the restore guard. A
  Session restores only a Model its selected Agent can still run.
- Provider availability, provider ownership binding, and how a rejected
  selection is surfaced stay with the caller. Three modes fail in three
  different ways — a thrown invocation error, a refused prompt, or an
  interactive dialog — and folding them into the order table would require a
  live Provider Collection to test an order that literals can test.
- The SDK's restored-defaults order (the Host's restore, then the stored row,
  then the handle's defaults) remains its own documented variant. It answers a
  different question — what an already-open handle defaults to next — and is not
  the stored-tier order.
- `resolveOutgoingSelection` and its helpers are deleted; no caller used them.
