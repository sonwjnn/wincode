<div align="center">

# wincode

**An agentic AI coding assistant that lives in your terminal — backed by a full-stack, type-safe platform.**

Multi-provider models · MCP tools · usage-based billing · local session history

[Overview](#overview) · [Architecture](#architecture) · [Getting Started](#getting-started) · [Development](#development) · [Deployment](#deployment)

</div>

---

## Overview

`wincode` is a Bun-powered monorepo that ships an AI coding agent as a rich terminal UI (TUI), together with the backend and web surface that support it. The CLI talks to model providers directly or routes through a hosted server for authentication, billing, and usage metering.

- **Terminal-native chat** — a React-rendered TUI (via [OpenTUI](https://github.com/sst/opentui)) with slash commands, file mentions, clipboard image paste, and persisted session history.
- **Bring your own model** — first-class connections to Anthropic, OpenAI, and Google, via API keys or browser OAuth. Provider onboarding is registry-driven.
- **MCP support** — connect Model Context Protocol servers (stdio & HTTP) with per-tool approval policies and a live status view.
- **Agent tools** — file read/write/edit, grep, and directory listing run locally in your working directory; the server only ever sees schema-only tool definitions.
- **Usage & billing** — end-to-end token accounting with a session usage bar, model-pricing sync, and [Polar](https://polar.sh)-backed subscriptions.
- **Type-safe end to end** — Hono RPC + tRPC contracts and Zod validation shared across every app.

## Tech Stack

| Layer   | Technologies                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime | [Bun](https://bun.sh) workspaces (catalog), [Turborepo](https://turbo.build)                                                          |
| CLI     | [OpenTUI](https://github.com/sst/opentui) + React 19, TanStack Router, [AI SDK](https://sdk.vercel.ai), Drizzle (local SQLite/libsql) |
| Server  | [Hono](https://hono.dev), tRPC, [Better Auth](https://better-auth.com), Polar, Drizzle + [Neon](https://neon.tech) Postgres           |
| Web     | TanStack Start SPA, shadcn/ui, TailwindCSS v4                                                                                         |
| Infra   | Cloudflare Workers via [Alchemy](https://alchemy.run) + Wrangler                                                                      |
| Tooling | [Ultracite](https://github.com/haydenbleasel/ultracite) / Biome, Lefthook                                                             |

## Architecture

The repo follows a **vertical-slice** architecture: features are self-contained modules, with a strict `app → modules → shared` dependency direction.

```text
apps/
├── cli/       # OpenTUI terminal agent — chat, connections, MCP, billing, sessions
├── server/    # Hono + tRPC API — auth, billing webhooks, sessions, credentials
└── web/       # TanStack Start SPA (Cloudflare Workers) — dashboard & auth

packages/
├── ai/        # AI SDK provider adapters + shared agent tools (read/write/edit/grep/list)
├── auth/      # Better Auth configuration
├── billing/   # Provider-agnostic billing/usage domain logic
├── db/        # Drizzle schema + Neon Postgres client
├── env/       # Validated environment (cli / server / web / ports)
├── infra/     # Alchemy infrastructure-as-code
├── ui/        # Shared shadcn/ui primitives
└── config/    # Shared TypeScript config
```

> [!NOTE]
> **Agent tools execute only on the CLI.** Tool _schemas_ are shared through `packages/ai` so the server and CLI agree on their shape, but the file-system runtime runs in your local working directory — the server never touches your files.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) `1.2.20+`
- A PostgreSQL database (a [Neon](https://neon.tech) serverless database is used by default) — required only for the server/web stack

### Install

```bash
bun install
```

### Configure environment

Each app reads its own environment, validated by `@wincode/env`. Populate the relevant `.env` files (for example `apps/server/.env`) with your database URL, auth secrets, provider keys, and billing credentials.

### Set up the database

The server-side schema targets Postgres via Drizzle:

```bash
bun run db:push       # apply schema to your database
bun run db:studio     # open Drizzle Studio
```

> [!TIP]
> The CLI stores conversation history in a **local** SQLite database, migrated automatically on first run — no external database is needed just to use the terminal agent.

## Development

Run each surface in its own terminal:

```bash
bun run dev:cli       # launch the terminal agent
bun run dev:server    # API server on http://localhost:3000
bun run dev:web       # web app on http://localhost:3001
```

Inside the CLI, use slash commands to manage your session — for example `/connect` to add a provider, `/models` to switch models, `/mcp` to inspect MCP servers, and `/sessions` to browse history.

### Common tasks

| Command                      | Description                             |
| ---------------------------- | --------------------------------------- |
| `bun run check`              | Lint & format check (Ultracite / Biome) |
| `bun run fix`                | Auto-fix lint & formatting issues       |
| `bun run check-types`        | Type-check every workspace              |
| `bun run test`               | Run unit tests across apps & packages   |
| `bun run test:integration`   | Run integration tests                   |
| `bun run build`              | Build all apps                          |
| `bun run sync:model-pricing` | Refresh the model-pricing snapshot      |

> [!IMPORTANT]
> Always use **Hono RPC** for requests between apps rather than raw `fetch`, and validate all input with **Zod** (`@hono/zod-validator` on the server, schemas on the client). Run `bun run fix` before committing — a Lefthook pre-commit hook enforces the standards in [`CLAUDE.md`](CLAUDE.md).

## Deployment

Infrastructure is defined as code with [Alchemy](https://alchemy.run) and deployed to Cloudflare Workers:

```bash
bun run deploy        # provision & deploy infrastructure
bun run destroy       # tear it down
```

## Documentation

- [`docs/adding-a-provider.md`](docs/adding-a-provider.md) — provider onboarding guide
- [`CONTEXT.md`](CONTEXT.md) — domain glossary (connections, providers, model catalog)
- [`CLAUDE.md`](CLAUDE.md) — coding standards (also at `AGENTS.md`)
