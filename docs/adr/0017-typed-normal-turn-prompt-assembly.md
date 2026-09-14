# Typed normal-turn Prompt Composition Pipeline and System Prompt

Status: accepted

Wincode keeps normal Agent Turn Prompt Composition in the TUI composition root. The public Prompt Composition Pipeline prepares resolved turn context, while pure `composeSystemPrompt()` renders the ordered provider-neutral System Prompt and returns its sidecar metadata. This preserves the Agent Core and AI SDK adapter contracts while making ordering, provenance, cache behavior, and diagnostics explicit.

## Considered Options

- **TUI-owned composition over Agent Core or runtime-owned assembly** — Project Instructions, workspace state, permissions, MCP snapshots, and resolved tools are TUI concerns; moving assembly into reusable contracts would couple them to filesystem or provider details.
- **`AGENTS.md` ancestor discovery over global, `CLAUDE.md`, override, or HTTP sources** — repository-local guidance is deterministic and independent of a user's home directory. Sources load farther-ancestor first, with the nearer source taking precedence.
- **Compact tool policy over duplicated tool schemas** — resolved tool descriptions, input schemas, and executors remain a separate model interface and cannot drift from prompt prose.
- **Untrusted Project Instructions over unrestricted system authority** — repository text may guide implementation but cannot override Wincode safety, direct user intent, Tool Permission, Agent role, or the workspace sandbox.
- **Preserved lazy Skill and separate compaction paths over a unified prompt** — activated Skill bodies remain turn-scoped user context, and compaction continues to use its dedicated summary instruction so neither surface contaminates the stable coding prompt.

## Consequences

- Primary Agents and same-workspace Subagents receive the same Project Instruction and environment snapshot, while Agent instructions, roles, tools, Skills, and transcripts remain turn-specific.
- `AGENTS.md` content is bounded to 12,000 characters per file and 24 KiB total. Missing files are ignored; invalid, unreadable, or oversized sources are omitted with diagnostics rather than failing or silently truncating a turn.
- Project Instructions carry workspace-relative provenance and SHA-256 content hashes. Raw repository instructions are not persisted in Session Records, telemetry, or compaction input.
- Snapshots are resolved before the first Model Step and remain stable for the Agent Turn. Cache reuse is keyed by canonical workspace and instruction-file metadata; later turns observe workspace changes.
- Stable environment is placed before dynamic tool policy and volatile status so the cacheable prompt prefix remains stable when only per-turn data changes. Environment variables, credentials, unnecessary absolute paths, full diffs, workspace trees, and machine metadata remain excluded.
- Prompt Composition is the process, System Prompt is only the provider-neutral system-role instruction content, and metadata or diagnostics remain sidecar in-process results.
- The TUI gains filesystem and workspace-context composition work, but no database schema, Agent Core contract, provider-specific prompt protocol, permission semantics, or Skill activation semantics changes.
