# `@wincode/subagents`

Durable delegation tools and the optional Subagents Plugin. The package root exports the reusable delegation tool contracts; `@wincode/subagents/plugin` exports the factory selected by the Wincode distribution.

## Owns

- Durable task and report storage, including its workspace-specific database path.
- Task coordination, cancellation, recovery, explicit result acknowledgement, and FIFO report delivery.
- The `delegate` and `submit_result` Plugin tools.
- Markdown agent discovery, shared Agent catalog registration, and the text-only `/subagents` command.
- A package-owned child-session factory that selects child Plugins, forwards capability ceilings, and manages Session lifecycle through the public Session SDK.

## Public Plugin boundary

The Subagents Plugin imports only public contracts from `@wincode/coding-agent`. It receives generic Session SDK operations through Plugin context, then its own child-session factory selects child Plugin paths (including its own source so a child can submit a result), forwards capability ceilings, and owns child handle cleanup. The package also owns task coordination and its task database. Child Sessions do not implicitly inherit every parent Plugin.

Application entry points select `@wincode/subagents/plugin` by default as a distribution package. SDK callers select its resolved file path explicitly with `pluginPaths`. A missing selected distribution package is reported as an installation error and can be disabled with `--no-plugin subagents`.

## Markdown agents

The package ships `scout`, `researcher`, `evidence-auditor`, `worker`, `reviewer`, `oracle`, and `delegate` definitions under `agents/`. Additional or overriding definitions are discovered recursively from:

1. the packaged agent directory;
2. `<userDataDir>/agents/**/*.md`;
3. `<workspace>/.wincode/agents/**/*.md`, only when the workspace is trusted.

A later scope overrides an earlier definition with the same `name`. Invalid files are ignored with a diagnostic, so a malformed override does not hide a valid lower-scope definition. The `/subagents` command lists effective subagents in plain text, including unavailable agents and the reason they cannot run.

Supported YAML frontmatter fields are `name`, `description`, optional `role` (`subagent` or `all`), `tools` (an array or comma-separated string), `requiredTools`, `model`, `thinkingLevel`, and `disabled`. The Markdown body is the agent's instructions. For example:

```markdown
---
name: test-author
description: Add contract-first tests for a focused behavior.
role: subagent
tools: [read, write, edit, glob, grep]
---
Inspect the existing tests first, then add a test for the user-visible contract.
```

Tool names outside Wincode's child coding-tool set are treated as required capabilities, not silently dropped: the agent is shown as unavailable and delegation is rejected with the missing tool names. In this release, child Sessions load the Subagents Plugin but do not inherit arbitrary parent Plugins or per-agent Plugin paths, so the bundled web-research profiles remain visible but unavailable.
