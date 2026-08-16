# Display Sanitation Lives in One Module Behind the Renderers

Secret redaction, ANSI stripping, cell measurement, and preview bounding are
display concerns that previously lived in four independent copies: the chat
renderer's unexported helpers, the approval dialog's formatter, the MCP error
sanitizer, and the MCP status dialog's defense-in-depth scrubber. The secret
key/value regex family was byte-identical in three of them, yet a fix had to
land in four places and could only be verified through rendered frames.

One display-sanitize module now owns the shared core — the secret regex
family, replacement literal, control-character and ANSI stripping, cell
measurement, wrapping, and preview bounds — behind a public seam. The chat
renderer, approval panels, and MCP dialogs are thin adapters over it.

Status: accepted

## Considered Options

- **One module, parameterized site budgets (accepted)** - A single regex
  family, replacement, and operation order (strip, then redact) live in
  `apps/cli/src/shared/display-sanitize`. Contexts that genuinely show
  different amounts keep their budgets as named options: chat tool arguments
  stay at 512 chars / depth 2 / 12 entries with a `[…]` depth marker, the
  approval dialog keeps 2048 chars / depth 4 / 24 entries with a plain `…`,
  and MCP error messages keep 2048 chars plus exact-config-secret
  substitution. The status dialog's defense-in-depth options (`redactUrls`,
  `keepKey`) are explicit opt-ins, so adopting the module does not change
  what the chat view shows.
- **Strict unification** - one constant set and one marker everywhere. Simplest
  surface, but visibly changes the approval dialog and chat rows, trading a
  behavioral regression for deduplication.
- **Regexes only** - share just the patterns and replacement. Leaves the
  recursive traversal, ANSI stripping, measurement, and preview logic
  duplicated, so most fixes would still land in several places.

## Consequences

- A redaction, stripping, or measurement fix lands once and is exercised by
  unit tests on the seam; the renderers keep their frame tests as an
  integration net.
- `bot-message.tsx` shrank from ~891 lines to ~490 by shedding its sanitation
  and formatting helpers; the `formatResponseTime` export-for-test smell is
  gone because the formatter now legitimately lives in the module.
- The approval formatter keeps `formatRejectionFeedback` (agent-input
  bounding, not display) and delegates its display functions to the module.
- The MCP status dialog's stronger redaction (URLs, key-preserving
  `token=[redacted]`) is preserved as opt-in options; its defense-in-depth
  contract is unchanged.
- Future renderers (web, TUI ports) must route display sanitation through the
  module seam instead of re-deriving patterns, or they re-open the divergence
  class this ADR closes.
- Fixes a pre-existing display bug: the CSI escape regex now includes the
  literal `[` (it previously left `[31m` visible after stripping only the ESC
  byte), which the seam's unit tests pin down.
