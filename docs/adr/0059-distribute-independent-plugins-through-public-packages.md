# Distribute independent Plugins through public packages

Status: proposed

## Context

Wincode can already load an explicitly enabled TypeScript Plugin and expose Tools, Commands, Providers, and host-mediated UI. A Plugin maintained in another repository must be able to use that public boundary without a Wincode checkout, workspace aliases, or private imports. The [Plugin research reference](../research/plugin.md) describes a broader extension surface than the [current public contract](../../packages/coding-agent/modules/plugins/public.ts); implementing that entire reference is not a prerequisite for distribution.

A local `bun pm pack` of `@wincode/coding-agent@0.1.0` included the CLI entry, root exports, and Plugin contract. Bun converted `workspace:*` and `catalog:` references into concrete versions or ranges. The packed manifest still requires six `@wincode/*` runtime packages, all at `0.1.0`. The public npm registry returned `404` for Coding-Agent and all six (`agent-core`, `ai`, `mcp`, `subagents`, `tui`, and `utils`) at the time of this check. Packing one package is not proof that the complete graph installs or runs. Existing CI builds binaries, but the [Plugin UI smoke option](../../scripts/interactive-smoke.sh) runs against source, not the release binary.

## Decision

- Publish `@wincode/coding-agent` as the Bun-based CLI and Plugin authoring contract, with its runtime dependency graph installable from the public registry. Publish `@wincode/tui` as the shared UI library. This keeps CLI ownership in [ADR-0042](0042-coding-agent-owns-cli-distribution.md) and renderer ownership in [ADR-0058](0058-reusable-react-tui-and-host-mediated-plugin-ui.md). Publishing a dependency does not make its internals part of the Plugin contract.
- Support one initial installation path: the user checks out an independent Plugin repository into `.wincode/plugins/<name>/`, installs its dependencies with Bun, and enables its TypeScript entry explicitly through config or `--plugin`. Project config still requires project trust under [ADR-0036](0036-plugin-loading-requires-explicit-enablement.md). The directory is a convention, not a discovery or execution trigger. Automatic installation, npm/Git specifiers in config, and JavaScript entry points are out of scope for this milestone.
- Plugin authors use public package exports and declare the supported host version range as a peer dependency. UI Plugins also declare the required UI peers. Host and Plugin must resolve the same React and `@wincode/tui` instances; matching version strings alone do not prove this. Document the supported Bun and host versions before release. Treat package-based installation as the initial supported host path; claim standalone binary support for external Plugins only after it passes the same smoke checks.
- Keep observation separate from intervention. When an external Plugin needs turn, tool, or model lifecycle events, expose a narrow, typed read-only surface backed by existing runtime events where appropriate. Define delivery order, failure isolation, payload visibility, and cleanup before claiming support. Do not expose the raw internal event union or make prompt/tool interception part of this distribution milestone.

## Release checks

1. **Package graph:** Pack all needed workspaces with the release toolchain. Inspect emitted manifests, including the Coding-Agent ↔ MCP/Subagents peer relationships. Install the packed graph from a clean directory outside the checkout using tarballs or a staging registry. Verify public imports, type declarations, CLI startup, and the default distributed Plugin dependencies without workspace links. After publish, repeat installation against the public registry.
2. **Independent Plugin install:** From that installation, type-check and run a separate fixture repository under `.wincode/plugins/<name>/` with its own dependencies and only public Wincode imports. Verify the Plugin does not execute merely by being present, project config is ignored before trust, explicit enablement exposes the fixture Command and Tool, and a bad Plugin does not prevent another valid Plugin from loading.
3. **Independent UI:** Render a separate TSX Plugin that uses a React hook and a public `@wincode/tui` component or hook. Verify it mounts under the host renderer, works after `/reload`, and leaves no duplicate contribution after replacement. Run against the installed CLI; repeat against release binaries before documenting binary support.

## Trade-offs

Manual checkout and explicit enablement add a step but leave dependency installation and execution under user control. A public package graph and a clean-room test add release work; they catch failures that monorepo links and source-only tests cannot. Event expansion can ship independently of package distribution.
