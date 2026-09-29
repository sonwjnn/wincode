# Session Hosts use process-owned writer locks

Status: accepted

This supersedes ADR-0026's expiring SQLite lease mechanism, not its one-writer-per-Session-ID invariant. One Session Writer may write a Session ID from Host opening through shutdown, including idle time and the completion of cancellation/checkpoint work. The Session Host holds a process-owned OS file lock on the same local machine to authorize its Agent Session as that writer: a suspended event loop or sleeping machine cannot expire the lock, and process death releases it without a wall-clock takeover. Concurrent Hosts for different Session IDs remain allowed within the same workspace; RPC v1 continues to use one Host per process under ADR-0025. Sessions in one checkout still rely on file-version checks and canonical-path leases for coding-tool edits under ADR-0024.

A competing opener must fail without constructing another Agent Session. Owner details (PID, execution mode, opening time) are best-effort diagnostics, never authority; a still-running but stuck owner cannot be forcibly unlocked. Normal shutdown stops new work, cancels an active turn, awaits its unwind and pending durable checkpoints, then releases the lock. Lock I/O or unsupported-lock errors fail closed and remain distinct from contention; no fallback to the old TTL protocol is allowed. Ownership is guaranteed only for processes sharing one local filesystem on one machine, not network-mounted stores. Mixed old/new Wincode binaries are unsupported: stop old processes before upgrading, and refuse a new opener if an active legacy SQLite lease is detected so it cannot coexist with an old writer.

On TUI contention only, users may explicitly inspect Stored Session History without acquiring writer authority. The view exposes committed data, not a Live Session Snapshot or a live follower: refresh is manual, no Session Commands are available, and switching to editing requires an explicit retry that acquires the lock and reloads state. Print and JSON report `session_in_use` on contention. RPC preserves that code and reports `session_lock_failed` for lock infrastructure failures. A failure to establish OS lock authority never grants this read-only contention fallback.

The lock filename is keyed by local database file identity and Session ID. It
lives in a persistent hidden directory beside the resolved database path, so
processes opening the same path share ownership despite different HOME/XDG
settings. Symlinks resolve to that path; the database path index normalizes
hard-link aliases within one Wincode data directory. Lock files are never
unlinked because replacement could split authority across distinct inodes.

The earlier expiring lease was chosen for cross-process safety and crash recovery using the existing SQLite store. It is replaced because a clock-based takeover can revoke a live Host after sleep or scheduling stalls, whereas a local OS lock tracks process-held ownership. The trade-off is deliberate: a live but hung owner blocks reopening until it is stopped, and the design does not promise network-filesystem coordination or live-follow viewing.
