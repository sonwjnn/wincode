<div align="center">

# wincode

**A local, terminal-native agentic coding assistant.**

Multi-provider models · MCP tools · local sessions · configurable agents

</div>

## Overview

`wincode` is a Bun-powered terminal coding agent. Agents, tools, skills, context, permissions, conversations, and model requests run from the local CLI. Model requests use provider APIs directly with credentials configured by the user; Wincode accounts and subscriptions are not required.

- **Terminal-native chat** — a React-rendered TUI via [OpenTUI](https://github.com/sst/opentui), with slash commands, file mentions, clipboard image paste, and persisted session history.
- **Bring your own model** — connect supported providers such as Anthropic, OpenAI, and Google with provider-owned API keys or supported provider OAuth.
- **MCP support** — connect Model Context Protocol servers with per-tool approval policies and a live status view.
- **Local agent tools** — file read/write/edit, grep, directory listing, and shell execution run in the local workspace through permission checks.
- **Skills** — local `SKILL.md` workflows can be invoked explicitly or activated by an agent through the native skill tool.
- **Configured agents** — built-in Build and Plan agents plus user-defined agents in `wincode.json` or `wincode.jsonc`.

## Tech Stack

| Layer | Technologies |
| --- | --- |
| Runtime | [Bun](https://bun.sh) workspaces |
| CLI | [OpenTUI](https://github.com/sst/opentui), React 19, TanStack Router, [AI SDK](https://sdk.vercel.ai), Drizzle local SQLite |
| Shared packages | AI provider adapters, agent schemas, tools, UI primitives, environment validation |
| Tooling | [Ultracite](https://github.com/haydenbleasel/ultracite) / Biome, Lefthook |

## Architecture

The maintained application is the CLI. Features follow `app → modules → shared` dependency direction.

```text
apps/
└── cli/       # terminal agent, providers, MCP, tools, sessions

packages/
├── ai/        # provider adapters, model catalog, agent schemas, tools
├── config/    # shared TypeScript configuration
├── env/       # CLI environment validation
└── ui/        # shared UI primitives
```

Conversation history and attachments use local storage. No external database or Wincode identity is needed to run the agent.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) `1.2.20+`
- An API key or supported provider credential for the model you want to use

### Install

```bash
bun install
```

### Run

```bash
bun run dev:cli
```

Inside the CLI, use slash commands such as `/connect` to add a provider, `/models` to choose a model, `/mcps` to manage MCP servers, and `/sessions` to browse local history.

## Development Commands

| Command | Description |
| --- | --- |
| `bun run check` | Lint and format check |
| `bun run fix` | Apply lint and formatting fixes |
| `bun run check-types` | Type-check every workspace |
| `bun run test` | Run the surviving test suite |
| `bun run dev:cli` | Launch the terminal agent |

Provider onboarding is documented in [`docs/adding-a-provider.md`](docs/adding-a-provider.md). Domain terminology is documented in [`CONTEXT.md`](CONTEXT.md). Coding standards are documented in [`AGENTS.md`](AGENTS.md).
