# Own model protocols and the Agent Runtime without AI SDK

Status: superseded by ADR-0048 and ADR-0049 for Provider SDK, application selection, and credential ownership.

Historical decision: Wincode replaced the private AI SDK adapter with provider-facing model clients in `@wincode/ai` and an Agent Runtime implementation in `@wincode/agent-core`. ADR-0048 established the independent Provider SDK contracts, and ADR-0049 records the Coding-Agent cutover. The enduring rationale is Wincode ownership of wire behavior and the Agent Runtime boundary, including the observable Agent Turn lifecycle; the former Catalog and Connections ownership described below is no longer current.

`@wincode/ai` historically owned the Model Catalog, model-protocol request/stream/error translation, and Connections, including credential validation, browser OAuth, refresh, and storage. Separate package subpaths kept catalog/model contracts independent of side-effecting model clients and Connections. A Connection Provider could expose more than one Model Protocol: OpenCode Go's model-specific routes had to continue to work. `@wincode/agent-core` consumes a provider-neutral model stream and owns Model Steps, tool execution, Steering Message delivery, and Agent Turn Events; it contains no provider-specific wire format.

The historical cutover removed `ai` and `@ai-sdk/*` after migrating all callers, including text generation for compaction, tests, and documentation. Supported model routes and OpenAI browser OAuth remained available. Agent Turn event and lifecycle behavior, including step limits, tool results, steering boundaries, cancellation, deadlines, usage, and failure mapping, remains the observable contract. Do not introduce a compatibility adapter.

Moving Connections did not itself change credential storage. The later Provider SDK cutover records the current application-owned CredentialStore and Provider identity rules in ADR-0049.

For OpenAI Responses, a streamed `response.output` continuation can be empty
even when a tool call was emitted separately. When replaying a Model Step,
serialize any tool calls missing from that continuation before their tool
results; otherwise the provider rejects the next request because the
`function_call_output` has no matching `function_call`. Reconciliation matches
by `call_id`: an existing provider call wins, missing local calls are appended
once, and provider continuation items retain their original order.
