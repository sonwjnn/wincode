# Compose coding tools through a catalog without moving the Tool Gate

Status: accepted

Coding tool metadata and execution are currently registered in separate maps:
schemas, names, model-facing definitions, and runners can drift when a tool is
added. The Coding-Agent Application will use a Coding Tool Catalog as the single
composition point for each coding tool's input and output schemas, description,
and runner. Individual read, write, edit, recover, search, and shell
implementations remain separate. The catalog derives names, definitions, and the
set of runtime-eligible coding tools instead of maintaining parallel registration
lists.

## Decision

- Keep the schema-only entry point free of runner and filesystem/shell imports.
  Compose the complete descriptors in a separate application module; the
  schema-to-runner join at this boundary is intentional, not another
  independently maintained tool inventory.
- Catalog membership means the application knows how to describe and execute a
  coding tool. It does not make the tool visible to any Agent or authorize a
  call. Agent visibility and the mapping from tool names to Tool Permission
  actions remain explicit. A newly cataloged tool is runtime-eligible but is
  unavailable to an Agent until deliberately selected and governed by permission
  policy.
- Keep `@wincode/agent-core`'s `ToolRegistry` definition-only. The application
  creates a Resolved Tool for an Agent Turn by composing its executor through the
  Tool Gate. A catalog runner must not become a public `registry.run` path around
  the gate. Preserve the existing dispatch and validation behavior; this
  refactor does not introduce implicit input parsing, output validation, or
  permission evaluation in the catalog. Distinguish input and output schemas
  rather than using an ambiguous `schema(name)` API.
- A descriptor's generic description serves approval and other non-model
  surfaces. Shell additionally provides `describe(platform)` for the
  model-facing definition; the definition factory receives a normalized shell
  platform explicitly, and production supplies the host platform. The catalog
  does not own Tool Gate recovery warnings or other per-call approval text.
- Move actual consumers to the catalog-derived interfaces and remove obsolete
  maps, lists, and unused exports instead of retaining compatibility aliases.
  Independently consumed concrete schemas and runners remain available.

## Considered options

- **Put complete descriptors in the schema-only module** — rejected because
  importing a schema would also load shell/filesystem execution dependencies.
- **Merge runner dispatch and the Tool Gate into a universal registry** —
  rejected because permission depends on the actual call and its Agent Turn; a
  direct execution API would obscure or bypass that boundary.
- **Automatically expose and authorize every catalog entry** — rejected because
  availability and Tool Permission are separate product and safety decisions.

## Consequences

Adding a coding tool has one metadata-and-runner composition point, but still
requires an intentional Agent visibility and permission decision. Runtime
definitions can vary by platform without a shell-name special case; approval
descriptions remain platform-neutral. This decision does not add Skill, MCP, or
delegation tools to the Coding Tool Catalog.
