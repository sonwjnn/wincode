# `@wincode/subagents`

Durable delegation tools and the optional Subagents Plugin. The package root exports the reusable delegation tool contracts; `@wincode/subagents/plugin` exports the factory selected by the Wincode distribution.

## Owns

- Durable task and report storage, including its workspace-specific database path.
- Task coordination, cancellation, recovery, explicit result acknowledgement, and FIFO report delivery.
- The `delegate` and `submit_result` Plugin tools.
- Child Session Plugin selection through the public Session SDK.

## Public Plugin boundary

The Subagents Plugin imports only public contracts from `@wincode/coding-agent`. It receives Session identity and SDK operations through generic Plugin hooks, creates child Sessions with explicit `pluginPaths` (including its own source so a child can submit a result), and owns its task database. Child Sessions do not implicitly inherit every parent Plugin.

Application entry points select `@wincode/subagents/plugin` by default as a distribution package. SDK callers select its resolved file path explicitly with `pluginPaths`. A missing selected distribution package is reported as an installation error and can be disabled with `--no-plugin subagents`.
