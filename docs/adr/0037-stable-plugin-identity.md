# Stable Plugin identity

Status: accepted

ADR-0039 extends Plugin Identifier ownership to built-ins and revises command collision handling by registration phase. ADR-0041 permits an explicitly requested direct model-visible tool name through the public Plugin contract, subject to shared collision checks; otherwise the file-loaded namespace remains the default. Permission actions, duplicate-ID precedence, and deterministic loading order remain in force.

Each Plugin loaded from a file declares a stable Plugin Identifier, and Wincode namespaces its Agent tool names under that identifier by default. The path of the source file is a loading location, not the Plugin's identity. This keeps Tool Permission rules and persisted tool-call names stable when a file moves or is renamed. Inferring identity from the filename would make those contracts depend on filesystem layout; a direct tool name instead requires an explicit request under ADR-0041, with host names protected by collision checks.

Plugin Identifiers use lowercase ASCII letters, digits, and underscores; local tool names also allow hyphens. For Plugin `jira` and tool `search-issues`, the Agent-facing name is `plugin_jira_search-issues` and the Tool Permission action is `plugin:jira:search-issues`.

Plugin Commands use short names such as `/hello`. A name collision with a Built-in Command, Custom Command, or another Plugin Command fails the attempted registration; the earlier command is never silently replaced. ADR-0039 defines how that failure affects factory, Session, and later registration scopes.

When two enabled files declare the same Plugin Identifier, the first successfully loaded Plugin keeps the identity and the later file is disabled with a diagnostic naming both paths. Loading order is deterministic and documented. CLI paths load before user-controlled configuration paths, so an explicit choice for one invocation takes precedence over a configured Plugin with the same identifier.
