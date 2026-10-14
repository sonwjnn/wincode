---
status: accepted
---

# Apply Persisted Project Trust on Restart

`/trust` persists a Project trust decision for future Wincode runtimes; it does not mutate the active runtime's trust snapshot. `/reload` refreshes configuration-backed resources under that snapshot, and a new runtime resolves the saved decision before loading protected project resources. Keeping persisted trust changes outside the active snapshot avoids enabling or revoking project-controlled code mid-session; the trade-off is that a persisted trust change requires a process restart even though ordinary resources can still be reloaded in place.
