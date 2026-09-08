# Shared Config

Domain-neutral Wincode configuration infrastructure for CLI capabilities. `createConfigStore()`
returns memoized, immutable snapshots through one `getSnapshot(workspace)` interface.
App composition creates one process-lifetime store and injects it into MCP, Custom Commands, and
Skills; capability modules do not reread Wincode JSON independently.

Each snapshot loads `wincode.jsonc` or `wincode.json` from four locations, from lowest to highest
precedence:

1. `${XDG_CONFIG_HOME:-~/.config}/wincode`.
2. `~/.wincode`.
3. `<workspace>`.
4. `<workspace>/.wincode`.

JSONC wins over JSON at the same location. Unsafe prototype keys reject their source. Objects merge
recursively; arrays and scalars replace earlier values. Snapshots retain ordered parsed sources,
generic diagnostics, and full-path provenance through `sourceFor(path)` so capability resolvers can
attribute their own diagnostics correctly.

Capability schemas and behavior do not belong here. MCP, commands, agents, skills, and future
capabilities resolve their own sections from the raw snapshot. Runtime state such as credentials,
conversations, and preferences is not merged configuration.

`ConfigStore.setValue(workspace, scope, path, value)` persists a JSON/JSONC value through the same
configuration boundary. Within the requested scope it updates the source that owns the path; when
the path is new, global writes target the XDG config source and project writes target the highest
precedence project `.wincode` source. Passing `undefined` removes a property. Existing JSONC
comments are preserved, and the workspace snapshot is refreshed after a successful write.
