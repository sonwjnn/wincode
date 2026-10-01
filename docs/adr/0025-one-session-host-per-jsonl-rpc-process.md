# One Session Host per JSONL RPC process

Wincode exposes a private JSON-RPC 2.0 protocol over strict JSONL stdin/stdout.
The first consumer is a trusted local orchestrator, so one process initializes
one Workspace, binds exactly once to one Session Host, and keeps that Host until
shutdown; the Agent Session is the sole state authority behind the adapter.

Status: accepted
Application-boundary note: ADR-0027 moved ownership of the RPC adapter from
the CLI package into RPC Mode of `@wincode/coding-agent` without changing the
one-Host-per-process lifecycle. This decision's wire contract is revised for
issue #149 below.

## Decision

- The client calls `initialize` with protocol major version, capabilities,
  client information, and an absolute working directory. Wincode resolves one
  canonical Workspace and returns the negotiated contract and supported
  capabilities.
- After initialization, the client calls exactly one of `session/create` or
  `session/open`. Creation accepts the first complete Submission and its
  required Session Selection; its input capabilities match ordinary
  `session/submit`. Opening names an existing Session in the initialized
  Workspace. A second bind is refused rather than replacing or multiplexing
  the Host.
- Submission input is structured and shared with Interactive Mode: text,
  supported attachments, explicit Skill intent, and Custom Command
  composition. Attachments are transported only as bounded inline bytes or
  previously ingested Attachment References; an untrusted filesystem path never
  implicitly authorizes a local read. Custom Commands expand through shared
  Submission preparation, retaining their expanded prompt rather than being
  re-executed during steering or retry.
- `session/submit` always admits a new Submission. It starts a turn when idle
  and enters the FIFO Submission Queue when busy; it never steers. The response
  identifies the Submission and its admission disposition.
- `session/steer` is a separate no-argument command. It takes exactly the
  oldest Queued Submission, commits its distinct user Session Record before
  acknowledging acceptance, and returns an explicit empty-queue, refusal, or
  accepted result; acceptance includes stable Submission and message
  identities. An empty queue creates no blank record. Repeated steer commands
  commit separate ordered messages rather than relabeling one waiting item.
- `session/retry` accepts only the `submissionId` of the failed head Steering
  Message while the Session is idle. It restarts processing with that existing
  user message and Submission identity; the response returns after the durable
  processing transition, and later status arrives through the state/event
  projection.
- `session/recall` withdraws selected or all still-uncommitted Queued
  Submissions. `session/interrupt` atomically stops the current Agent Turn or
  compaction and settles pending approvals; it may Recall uncommitted queue
  entries under the shared policy, but neither operation withdraws committed
  Steering Messages.
- The command response reports validation, refusal, admission, or durable
  steering acceptance. The adapter publishes typed Agent Turn Events and a
  wire-specific state projection, not `SessionSnapshot`; the projection
  excludes Session Context, accumulated Session View State, host objects, and
  JavaScript errors. It exposes queue entries and committed input identities
  with accepted/pending/failed processing status. Session Transcript history
  remains available through a paginated method rather than repeated in state
  notifications.
- A preparation or model-request failure identifies the blocked committed
  message and reason, leaves its identity durable, and stops later pending
  messages from overtaking it. Neither the Session nor adapter blindly retries
  an uncertain request. `session/retry` is the explicit RPC retry command;
  Interactive Mode's Retry action uses the same committed identity. Unsteered
  Queued Submissions remain process-local and are never replayed after restart.
- Pending Approval Requests appear in the state projection and settle through
  `session/respondToApproval`. The wire supports allow-once, persistent allow
  where the Tool Permission safety contract permits it, reject with optional
  feedback, and abort.
- Every client command carries a unique connection-scoped string request ID.
  Request IDs correlate responses only; protocol version 2 provides neither
  event replay nor automatic retry of an uncertain command after process death.
  Reconciliation uses durable Session Message and Submission identifiers.
- One serialized stdout writer establishes line order. Server notifications
  carry a monotonic process-local sequence. Output buffering is bounded;
  replaceable state projections may coalesce, but responses and Agent Turn
  Events never silently drop. Exhausting the bound is fatal.
- Logical shutdown stops admission, shuts down the Host, issues aborts, settles
  Agent Session state, and flushes output with a deadline. It does not wait
  forever to prove that every remote provider or subprocess physically exited.

## Considered options

- **Pre-bound, replaceable sessions** — deferred. Wincode creates a durable
  Session with its first user record, while the first RPC consumer benefits
  more from one child process representing one child Session. A later
  external-UI use case may justify a replaceable Host owner without changing
  the Agent Session.
- **Multiple Session Hosts in one process** — rejected for protocol version 2.
  It requires a session registry, session identifiers on every method and
  notification, aggregate scheduling, and cross-session backpressure with no
  need from the first consumer.
- **Custom request/response envelopes** — rejected. JSON-RPC already defines
  correlation, results, errors, and notifications; Wincode needs to own only
  its methods, DTOs, and stable application error codes.
- **Raw Agent Session methods and Snapshots** — rejected. They expose internal
  contracts and accumulated streaming state, and make transport compatibility
  follow internal refactors. The adapter publishes its own stable projection.
- **Text-only input or submit-driven auto-steering** — rejected. RPC and
  Interactive Mode share structured Submission preparation, while `submit`
  always admits new work and only explicit `session/steer` takes the queue
  head.
- **Arbitrary attachment paths or automatic replay** — rejected. Attachments
  require bounded inline content or previously ingested references, and an
  uncertain command is reconciled by durable input identities rather than
  blindly resent.
- **Durable JSON-RPC idempotency** — deferred. The local stdio connection has
  no reconnect or replay contract; a future automatic crash-retry requirement
  should introduce a distinct durable Client Submission Key rather than
  persist transport request IDs.

## Consequences

- A React-free capability composer supplies the existing `SessionCapabilities`
  contract before the RPC controller can create a Host.
- Interactive and RPC adapters use the same Agent Session admission,
  queue-head steering, preparation, Recall, persistence, and failure behavior;
  neither adapter selects a lane on the caller's behalf.
- The breaking change is reflected in negotiated protocol major version 2:
  `initialize` advertises structured Submission input, explicit steering, and
  failed-Submission retry. Version 1 clients are rejected; the former text-only,
  submit-driven auto-steering contract is not retained.
- The Coding-Agent Application gains one lazily loaded non-interactive RPC
  Mode without loading OpenTUI. `stdout` is protocol-only and human-readable
  diagnostics use `stderr`.
- Concurrent Sessions require concurrent child processes in protocol version 2.
  The protocol may gain Host replacement later, but doing so reopens this
  decision rather than silently turning the controller into a session server.
