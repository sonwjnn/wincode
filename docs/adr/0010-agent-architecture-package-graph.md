# Split the agent architecture into acyclic concern packages

Wincode's agent architecture is split into public `@wincode/ai`, `@wincode/agent-core`, `@wincode/coding-tools`, `@wincode/mcp`, `@wincode/skills`, and `@wincode/tui` packages, plus the private `@wincode/agent-runtime-ai-sdk` adapter and `apps/cli` composition root. This makes package ownership match reasons to change instead of retaining the broad `@wincode/ai` barrel.

Status: accepted

## Decision

- `@wincode/ai` owns provider-neutral model contracts, catalog, targets, options, capabilities, usage, and failures.
- `@wincode/agent-core` owns Agents, Agent Turns, lifecycle, events, records, failures, the Agent Runtime interface, and generic tool definitions, registry, calls, and results.
- `@wincode/coding-tools` implements filesystem, search, edit, shell, workspace-policy, hashline, diff, and resource-limit tools against core tool contracts.
- `@wincode/mcp` adapts MCP clients, discovery, and invocation to core tool contracts; CLI configuration, approval, and UI remain outside it.
- `@wincode/skills` owns Skill contracts, parsing, catalog, snapshots, and activation semantics; its `./filesystem` export owns Node/Bun discovery and content loading. CLI supplies explicit root descriptors, permission enforcement, persistence, and presentation.
- `@wincode/tui` renders core records and events through OpenTUI without importing CLI application modules.
- `@wincode/agent-runtime-ai-sdk` privately implements the core runtime interface with AI SDK.
- `apps/cli` owns Connections, conversation orchestration and persistence, Tool Gate, approval, configuration, routing, and composition.

`@wincode/ai` and `@wincode/skills` are base packages; `@wincode/agent-core` depends on both for model and typed Skill Activation contracts. Core does not import concrete tools, MCP, TUI, persistence, CLI, or AI SDK. Package consumers use declared exports rather than source-path or umbrella-barrel imports.

## Consequences

Concrete coding tools remain separate from their agent-facing registry and protocol, preventing filesystem and shell dependencies from entering the core. No native, generic utilities, persistence, RPC/ACP, or separate TUI application-state package is created without an independent seam. The existing broad `@wincode/ai` exports are removed after all callers migrate; no compatibility umbrella remains.
