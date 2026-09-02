# Isolate AI SDK behind Wincode Agent Runtime contracts

Wincode owns the Agent Turn, Agent Turn Event, Conversation Record, Operational Failure, Model Target, and Agent Runtime contracts. AI SDK types and lifecycle semantics must not cross those interfaces; `@wincode/agent-runtime-ai-sdk` adapts AI SDK models, tools, streams, usage, and errors to Wincode contracts.

Status: accepted

## Considered options

- Exposing AI SDK contracts directly would reduce translation code but couple application, persistence, and presentation behavior to a framework-specific protocol.
- Reimplementing model streaming and the complete tool loop would maximize control but duplicate mature AI SDK mechanics without a demonstrated need.

## Consequences

The adapter may continue to use AI SDK `ToolLoopAgent` internally. Expected failures become typed Wincode events, invariant violations remain thrown errors, and HTTP, RPC, UI, persistence, and telemetry representations are mapped only at their adapters. This introduces translation cost in exchange for stable Wincode semantics and replaceable infrastructure.
