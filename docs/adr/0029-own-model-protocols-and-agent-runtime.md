# Own model protocols and the Agent Runtime without AI SDK

Status: accepted

Wincode will replace the private AI SDK adapter with provider-facing model clients in `@wincode/ai` and an Agent Runtime implementation in `@wincode/agent-core`. This reverses ADR-0009's decision to delegate model streaming and the tool loop to AI SDK, and supersedes the adapter-specific package boundary in ADR-0010 and the AI SDK step-hook mechanism in ADR-0022. Wincode takes on protocol, streaming, and tool-continuation maintenance in exchange for owning those behaviors end to end.

`@wincode/ai` owns the Model Catalog, model-protocol request/stream/error translation, and Connections, including credential validation, browser OAuth, refresh, and storage. Separate package subpaths keep catalog/model contracts independent of the side-effecting model clients and Connections. A Connection Provider may expose more than one Model Protocol: OpenCode Go's model-specific routes must continue to work. `@wincode/agent-core` consumes a provider-neutral model stream and owns Model Steps, tool execution, Steering Message delivery, and Agent Turn Events; it contains no provider-specific wire format. `@wincode/coding-agent` keeps the Connections dialogs and React context.

The cutover removes `ai`, `@ai-sdk/*`, and `@wincode/agent-runtime-ai-sdk` after migrating all callers, including text generation for compaction, tests, and documentation. All currently supported model routes and OpenAI browser OAuth remain available. Agent Turn event and lifecycle behavior, including the existing step limits, tool results, steering boundaries, cancellation, deadlines, usage, and failure mapping, remains the observable contract. Do not introduce a compatibility adapter.

Moving Connections does not itself change credential storage. If a new storage format is needed, use a new namespace without migration or deletion of the old credentials; reconnecting is acceptable in this development-stage project. Otherwise retain the existing credential store so package relocation alone does not force reconnecting.
