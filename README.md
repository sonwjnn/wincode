<div align="center">

# Wincode

**A local-first coding agent for your terminal.**

[![Test](https://github.com/sonwjnn/wincode/actions/workflows/test.yml/badge.svg)](https://github.com/sonwjnn/wincode/actions/workflows/test.yml)
[![Bun](https://img.shields.io/badge/Bun-1.2.20-fbf0df?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Features](#features) • [Getting started](#getting-started) • [Configuration](#configuration) • [Commands](#commands) • [Architecture](ARCHITECTURE.md) • [Development](#development)

</div>

Wincode is an interactive terminal UI for working with AI coding agents. It combines direct model-provider connections, workspace-aware coding tools, durable local sessions, configurable agents, Skills, custom commands, and MCP servers in one interface.

> [!NOTE]
> Wincode is under active development and currently runs from a source checkout; it is not published as a standalone package yet.

## Features

- **Terminal-native workflow** — a responsive [OpenTUI](https://github.com/anomalyco/opentui) interface with streaming responses, Markdown rendering, syntax highlighting, diffs, themes, and keyboard-driven dialogs.
- **Multiple model providers** — connect OpenAI, Anthropic, Google, or OpenCode Go with an API key; OpenAI also supports browser OAuth.
- **Workspace-aware tools** — bounded read, glob, grep, edit, write, and shell tools operate inside the active workspace.
- **Explicit safety controls** — per-agent and per-resource `allow`, `ask`, and `deny` policies, inline approvals, temporary grants, and optional auto approval.
- **Local session history** — sessions, completed tool calls, compactions, and attachments are stored locally in SQLite. Credentials use the platform secret store when available, with a secure local fallback.
- **Extensible agent context** — use `@path` file mentions, reusable Skills, prompt-based custom commands, and local or remote MCP tool servers.
- **Configurable agents** — choose built-in or project-defined agents with independent roles, instructions, model pins, permissions, and resource limits.

## Getting started

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun 1.2.20](https://bun.sh/docs/installation) or a compatible newer release
- An account or API key for at least one [supported provider](#supported-providers)

### Run Wincode

```bash
git clone https://github.com/sonwjnn/wincode.git
cd wincode
bun install --frozen-lockfile
bun run dev:cli
```

Inside Wincode:

1. Run `/connect` and authenticate with a provider.
2. Run `/models` to choose a model.
3. Enter a task, or type `@` to attach workspace files.

To use the checkout against another project, start the entrypoint from that project's directory:

```bash
cd /path/to/your/project
bun run /path/to/wincode/packages/cli/src/index.ts
```

> [!TIP]
> Pass `--auto` to start with automatic approval enabled. Explicit `deny` rules still take precedence.
>
> ```bash
> bun run /path/to/wincode/packages/cli/src/index.ts --auto
> ```

### Supported providers

| Provider | Connection methods |
| --- | --- |
| OpenAI | API key, browser OAuth |
| Anthropic | API key |
| Google | API key |
| OpenCode Go | API key |

Provider credentials are configured interactively with `/connect`, not stored in project configuration.

## Configuration

Wincode reads `wincode.jsonc` or `wincode.json`, with JSONC taking precedence at the same location. Configuration is merged from lower to higher precedence:

1. `${XDG_CONFIG_HOME:-~/.config}/wincode/`
2. `~/.wincode/`
3. The workspace root
4. `<workspace>/.wincode/`

Objects merge recursively; arrays and scalar values replace lower-precedence values. Restart Wincode after changing configuration.

```jsonc
{
  "default_agent": "build",
  "permission": {
    "read": "allow",
    "edit": {
      "*.env*": "deny",
      "src/**": "ask"
    }
  },
  "agents": {
    "review": {
      "role": "primary",
      "description": "Review changes without editing files.",
      "instructions": "Inspect the implementation and report concrete risks.",
      "permission": {
        "edit": "deny",
        "write": "deny"
      }
    }
  },
  "mcp": {
    "context7": {
      "type": "local",
      "command": ["npx", "-y", "@upstash/context7-mcp"],
      "enabled": true,
      "permission": "ask"
    }
  },
  "skills": {
    "paths": ["./skills"]
  },
  "commands": {
    "paths": ["./commands"]
  }
}
```

> [!WARNING]
> A local MCP server runs the configured command in your workspace. Only configure servers you trust; set `enabled` to `false` to prevent startup.

Detailed configuration references:

- [Agents](packages/tui/modules/agents/README.md)
- [Tool permissions](packages/tui/modules/permissions/README.md)
- [Skills](packages/tui/modules/skills/README.md)
- [Custom commands](packages/tui/modules/custom-commands/README.md)
- [MCP servers](packages/tui/modules/mcp/README.md)
- [Configuration precedence](packages/tui/shared/config/README.md)

### Skills

A Skill is a directory containing a `SKILL.md` file with `name` and `description` frontmatter. Put project Skills in `.wincode/skills/<skill-name>/SKILL.md`, select one with `/skills`, or invoke it directly with `/skill-name arguments`. Agents can also activate available Skills when a task requires them.

### Custom commands

Place prompt templates in `.wincode/commands/*.md`. The filename becomes the command name; optional YAML frontmatter supplies its description. Templates support `$ARGUMENTS`, positional `$1`…`$n` values, and `$$` for a literal dollar sign.

### MCP servers

The `mcp` map supports local subprocess servers and remote Streamable HTTP servers. Each server can define environment variables or headers, startup/catalog/execution timeouts, and its own permission policy. Use `/mcps` to inspect, enable, disable, or reconnect configured servers.

## Commands

Type `/` in the chat input to browse Built-in Commands, Custom Commands, and Skills.

| Command | Action |
| --- | --- |
| `/new` | Start a new session |
| `/compact [focus]` | Summarize completed history while keeping the transcript visible |
| `/settings` | Open application settings |
| `/agents` | Switch agents and inspect agent configuration |
| `/models` | Select a model |
| `/variants` | Select a model variant |
| `/skills` | Browse and insert available Skills |
| `/sessions` | Browse, rename, pin, or delete local sessions |
| `/themes` | Change the terminal color theme |
| `/connect` | Connect a provider account or API key |
| `/mcps` | Inspect and control MCP servers |
| `/permissions` | Manage approvals, temporary grants, and auto approval |
| `/exit` | Quit Wincode |

## Architecture

Wincode is a Bun workspace with separate executable and interactive composition roots:

```text
.
├── packages/
│   ├── cli/                      # Executable dispatch, help, version, diagnostics
│   ├── tui/                      # OpenTUI app, routing, sessions, config, MCP, approvals
│   ├── ai/                       # Provider-neutral model catalog, targets, options, usage, failures
│   ├── agent-core/               # Agent Turns, records, events, runtime and tool contracts
│   ├── agent-runtime-ai-sdk/     # Private AI SDK runtime and provider adapters
│   ├── coding-tools/             # Workspace sandbox, filesystem, search, edit, and shell tools
│   └── skills/                   # Skill parsing, discovery, catalog, snapshots, and activation
└── docs/
    └── adr/                      # Accepted architecture decisions
```

The dependency direction keeps model and Agent contracts independent from the CLI, OpenTUI, persistence, MCP transports, and concrete coding tools. See the concise [architecture guide](ARCHITECTURE.md) for the runtime flow and boundaries, or [ADR 0010](docs/adr/0010-agent-architecture-package-graph.md) for the underlying decision.

## Development

Install dependencies once from the repository root:

```bash
bun install --frozen-lockfile
```

| Command | Purpose |
| --- | --- |
| `bun run dev:cli` | Run the CLI in watch mode |
| `bun test` | Run the deterministic, offline test lane |
| `bun run test:integration` | Run local integration tests |
| `bun run check-types` | Type-check every workspace package |
| `bun run check` | Run Ultracite checks |
| `bun run fix` | Apply Ultracite formatting and safe fixes |

Session storage uses the current Drizzle schema without migration history. After changing `packages/tui/modules/sessions/storage/schema.ts`, run:

```bash
bun run --cwd packages/tui db:push
```

If Drizzle cannot reconcile a local schema change safely, reset the local database and attachment data before restarting Wincode. The session-only reset command is:

```bash
bun run --cwd packages/tui db:reset-sessions
```
