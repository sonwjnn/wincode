# Stable Plugin identity

Status: accepted

Each Plugin loaded from a file declares a stable Plugin Identifier, and Wincode namespaces its Agent tool names under that identifier. The path of the source file is a loading location, not the Plugin's identity. This keeps Tool Permission rules and persisted tool-call names stable when a file moves or is renamed, and prevents a Plugin Tool from claiming a built-in tool name. Inferring identity from the filename or accepting unqualified tool names would make those contracts depend on filesystem layout or registration order.

Plugin Identifiers and local tool names use lowercase ASCII letters, digits, and underscores. For Plugin `jira` and tool `search_issues`, the Agent-facing name is `plugin_jira_search_issues` and the Tool Permission action is `plugin:jira:search_issues`.

Plugin Commands use short names such as `/hello`. A name collision with a Built-in Command, Custom Command, or another Plugin Command invalidates the later Plugin registration as a whole; the earlier command is never silently replaced.

When two enabled files declare the same Plugin Identifier, the first successfully loaded Plugin keeps the identity and the later file is disabled with a diagnostic naming both paths. Loading order is deterministic and documented. CLI paths load before user-controlled configuration paths, so an explicit choice for one invocation takes precedence over a configured Plugin with the same identifier.
