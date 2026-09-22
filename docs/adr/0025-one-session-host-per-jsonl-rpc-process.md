# One Session Host per JSONL RPC process

Wincode will expose its first non-interactive session surface as a private JSON-RPC 2.0 protocol over strict JSONL stdin/stdout. The first consumer is a trusted local orchestrator, so one process initializes one Workspace, binds exactly once to one Session Host, and keeps that Host until shutdown; the Session Engine remains the sole state authority behind the adapter.

Status: accepted

## Decision

- The client calls `initialize` with protocol major version, capabilities, client information, and an absolute working directory. Wincode resolves one canonical Workspace and returns the negotiated version and supported capabilities.
- After initialization, the client calls exactly one of `session/create` or `session/open`. Creation includes the first text Submission and its required Session Selection because a Wincode Session begins with its first durable user record; opening names an existing Session in the initialized Workspace. A second bind is refused rather than replacing or multiplexing the Host.
- `session/submit` is the only Submission admission method. The Engine decides whether the Submission starts, enters the Steering Lane, or enters the Submission Queue. Admission returns a server-generated Submission Identifier and disposition; the identifier survives disposition changes for that process lifecycle but is not a transport request identifier or durable replay key.
- `session/interrupt` atomically stops the current Agent Turn or compaction, settles pending approvals, and Recalls both waiting lanes. `session/recall` withdraws selected or all waiting Submissions without stopping active work. Neither `steer`, `follow_up`, `clear_queue`, nor raw Engine cancellation is exposed.
- A command response reports validation, refusal, or admission. Agent Turn progress and terminal outcomes remain typed Agent Turn Events. The adapter publishes a wire-specific operational state projection, not `SessionSnapshot`; the projection excludes Session Context, accumulated Session View State, host objects, and JavaScript errors. Session Transcript history is read through a paginated method rather than repeated in state notifications.
- Text-only v1 limits new Submission input, not Agent capability. The Host still composes the real Connections, Agent Runtime, MCP, Skills, tools, Tool Permission, compaction, attachments, and persistence capabilities. Existing attachment references may appear as metadata, but v1 accepts no attachment bytes or new attachment references.
- Pending Approval Requests appear in the state projection and settle through `session/respondToApproval`. The wire supports allow-once, persistent allow where the Tool Permission safety contract permits it, reject with optional feedback, and abort.
- Every client command carries a unique connection-scoped string request ID. Request IDs correlate responses only; v1 provides neither event replay nor automatic retry of an uncertain command after process death. Reconciliation uses durable Session Message and Agent Turn identifiers.
- One serialized stdout writer establishes line order. Server notifications carry a monotonic process-local sequence. Output buffering is bounded; replaceable state projections may coalesce, but responses and Agent Turn Events never silently drop. Exhausting the bound is fatal.
- Logical shutdown stops admission, shuts down the Host, issues aborts, settles Engine state, and flushes output with a deadline. It does not wait forever to prove that every remote provider or subprocess physically exited.

## Considered options

- **Pre-bound, replaceable sessions** — deferred. Wincode creates a durable Session with its first user record, while the first RPC consumer benefits more from one child process representing one child Session. A later external-UI use case may justify a replaceable Host owner without changing the Engine.
- **Multiple Session Hosts in one process** — rejected for v1. It requires a session registry, session identifiers on every method and notification, aggregate scheduling, and cross-session backpressure with no need from the first consumer.
- **Custom request/response envelopes** — rejected. JSON-RPC already defines correlation, results, errors, and notifications; Wincode needs to own only its methods, DTOs, and stable application error codes.
- **Raw Session Engine methods and Snapshots** — rejected. They expose implementation contracts, give the client control over lane policy, duplicate accumulated streaming state, and make transport compatibility follow internal refactors.
- **Durable JSON-RPC idempotency** — deferred. The local stdio connection has no reconnect or replay contract; a future automatic crash-retry requirement should introduce a distinct durable Client Submission Key rather than persist transport request IDs.

## Consequences

- A React-free capability composer must supply the existing `SessionCapabilities` contract before the RPC controller can create a Host.
- Submission admission needs a uniform immediate Engine contract and a stable Submission Identifier; the adapter must not infer admission from the timing of the current `send` promise.
- The CLI gains one lazily loaded non-interactive command without loading OpenTUI. `stdout` is protocol-only and human-readable diagnostics use `stderr`.
- Concurrent Sessions require concurrent child processes in v1. The protocol may gain Host replacement later, but doing so reopens this decision rather than silently turning the controller into a session server.
