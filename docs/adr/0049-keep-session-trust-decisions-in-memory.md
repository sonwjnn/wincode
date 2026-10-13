---
status: accepted
---

# Keep Session Trust Decisions In Memory

Interactive trust prompts and `/trust` may apply a **Session trust decision**: a Project trust decision that is never written to the user's trust file. It lives in the interactive runtime context so Resource Reload keeps applying it instead of silently reverting to the saved decision, and saving any persisted decision replaces it. A Session trust decision also outranks the invocation-level `--trust-project` / `--no-trust-project` override, because it is the user's most recent explicit choice. Wincode offers the choice because a user may need to load or refuse project resources for a single run without recording a decision they did not mean to keep; treating session choices as saved ones would write decisions to disk the user never asked to keep.
