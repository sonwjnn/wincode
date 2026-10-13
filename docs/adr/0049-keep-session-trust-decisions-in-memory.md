---
status: accepted
---

# Keep Session Trust Decisions In Memory

Interactive startup trust prompts may apply a **Session trust decision**: a Project trust decision that is never written to the user's trust file. It lives in the interactive runtime context, and Resource Reload preserves the active runtime's trust snapshot rather than replacing it with a later saved decision. A Session trust decision also outranks the invocation-level `--trust-project` / `--no-trust-project` override, because it is the user's most recent explicit choice. Persisted decisions saved with `/trust` affect the next Wincode runtime after restart, not the current one (ADR-0050). Wincode offers session-only choices because a user may need to load or refuse project resources for one run without recording a decision they did not mean to keep; treating session choices as saved ones would write decisions to disk the user never asked to keep.
