# Isolate AI SDK behind Wincode Agent Runtime contracts

Historical decision: Wincode owned the Agent Turn, Agent Turn Event, Session Record, Operational Failure, Model Target, and Agent Runtime contracts. AI SDK types and lifecycle semantics were kept behind an adapter. ADR-0029 supersedes this boundary: `@wincode/ai` owns model protocols and clients, while `@wincode/agent-core` owns the Agent Runtime implementation.

Status: superseded by ADR-0029

## Considered options

- Exposing AI SDK contracts directly would reduce translation code but couple application, persistence, and presentation behavior to a framework-specific protocol.
- Reimplementing model streaming and the complete tool loop would maximize control but duplicate mature AI SDK mechanics without a demonstrated need.

## Consequences

This ADR's adapter consequences are historical and superseded by ADR-0029.
