# Shared Config

Domain-neutral Wincode configuration infrastructure for CLI capabilities. `createConfigStore()` returns memoized, immutable settings snapshots through one `getSnapshot(workspace)` interface.

General settings are loaded from the user's `~/.wincode/settings.json` or `settings.jsonc`, followed by trusted project `.wincode/settings.json` or `settings.jsonc` files from ancestor to workspace. `settings.jsonc` wins when both filenames exist at one scope and produces a duplicate-config diagnostic. Old XDG roots and project-root `wincode.json` / `wincode.jsonc` files are not runtime sources. Project settings are not read until Project trust has been granted.

Objects merge recursively; arrays and scalars replace earlier values. Snapshots retain ordered parsed sources, generic diagnostics, and full-path provenance through `sourceFor(path)` so capability resolvers can attribute their diagnostics correctly. Capability schemas and behavior do not belong here. Unknown settings remain inert unless a capability consumes them.

The ConfigStore also exposes namespace-scoped document operations for capability-owned files such as `mcp.json`. The host resolves `<user-or-trusted-project>/.wincode/<namespace>.json`, parses generic JSON, enforces namespace/path boundaries, and performs safe writes without interpreting the document schema. MCP configuration is therefore not part of the general settings snapshot.

`ConfigStore.setValue(workspace, scope, path, value)` persists a settings value through the settings boundary. Within the requested scope it updates the source that owns the path; when the path is new, global writes target the user settings file and project writes target the highest-precedence trusted project settings file. Namespace writes use the same ownership and atomic-write guarantees while targeting only their namespace document. Existing JSONC comments are preserved, and the relevant snapshot is refreshed after a successful write.
