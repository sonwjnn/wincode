# Session Hosts hold exclusive renewable Session Leases

A Session Engine is the single owner of one session's live state, but SQLite WAL serialization alone does not prevent a TUI and an RPC process from opening separate Engines for the same durable Session and interleaving records. Every Session Host will therefore hold an exclusive renewable Session Lease for its full lifetime, extending the single-owner invariant across processes.

Status: accepted

## Decision

- `createSessionHost` acquires the Session Lease before reading the durable state or constructing the Engine. The Host releases it during shutdown.
- The lease is shared by every consumer of Session Host, including the TUI and JSONL RPC process. An RPC-only guard would leave the actual split-brain case open.
- Leases live in the shared SQLite store and use opaque owner tokens, atomic acquisition/takeover, expiry, and heartbeat renewal. The initial policy matches the existing file-lease posture: a 30-second lease renewed every 10 seconds.
- A non-expired lease refuses another opener with the stable `session_in_use` failure. An expired lease may be taken over so a crashed process cannot strand a Session permanently.
- Losing a lease while a Host is live is fatal to that Host: it interrupts work, settles pending lifecycle state, shuts down, and reports `session_lease_lost` rather than allowing two writers to continue.
- Owner tokens are infrastructure details and never cross the Session Host or RPC contracts. V1 has no read-only Host mode that bypasses the lease.

## Considered options

- **Trust each orchestrator and UI not to overlap** — rejected: ownership would be a convention invisible to independent processes, and a normal TUI-plus-RPC overlap could violate it.
- **Process-local registry** — rejected: it catches duplicate opens only inside one heap.
- **RPC-only lease** — rejected: it cannot exclude the TUI, tests, or another future Host consumer.
- **OS advisory lock file** — rejected: the shared SQLite store already identifies the durable Session and provides atomic cross-process coordination plus recoverable expiry without a second path/cleanup contract.

## Consequences

- The Session Store gains lease acquisition, renewal, and release operations and a current-schema lease table; Wincode continues its direct schema synchronization policy rather than adding migration history.
- Host lifetime now includes a heartbeat and a lease-loss path in addition to Engine shutdown. A consumer cannot claim successful opening until acquisition completes.
- Tests and surfaces that intentionally open the same Session twice must instead use distinct Sessions or explicitly shut down the first Host.
