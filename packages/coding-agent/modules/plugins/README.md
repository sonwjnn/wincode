# File-loaded Plugins

File-loaded Plugins are trusted TypeScript modules that Wincode explicitly loads into its process. They can register gated Agent Tools and direct Interactive Mode commands through the public `@wincode/coding-agent` API.

## Enable a Plugin

A Plugin file in `.wincode/plugins/` is **not** loaded just because Wincode opens that workspace. Enable it for one run with a repeatable CLI option:

```sh
wincode --plugin .wincode/plugins/jira.ts
```

CLI-relative paths resolve from the workspace. To enable a Plugin on every run, add an absolute path to a personal configuration file such as `~/.config/wincode/wincode.json`:

```json
{
  "plugins": ["/Users/alex/project/.wincode/plugins/jira.ts"]
}
```

Project configuration cannot authorize Plugin code. If a CLI path and a configured path declare the same Plugin Identifier, the CLI Plugin loads first. Wincode accepts TypeScript paths (`.ts`, `.tsx`, `.mts`, `.cts`) and reports invalid, missing, or failed Plugins without preventing other Plugins from loading.

Enabling a path is a trust decision: Plugin code runs with Wincode's process permissions, including code executed while the module loads. Plugins are not sandboxed, and Wincode does not install their dependencies. Local imports and dependencies already available to the Plugin may be used. `--no-plugin <id>` and the personal `disabledPlugins` setting disable only known default/distribution Plugins before loading them; they do not disable explicitly selected file paths. Remove a file path from the CLI or personal configuration to stop that Plugin from loading.

## Author a Plugin

Export one default factory. The authoring types are available from the installed Wincode package; Plugin code does not need internal Coding-Agent imports.

```ts
import type { PluginFactory } from "@wincode/coding-agent";
import { z } from "zod";

const jiraPlugin: PluginFactory = (api) => {
  const jira = api.definePlugin({ id: "jira" });

  jira.registerTool({
    name: "search_issues",
    description: "Search Jira issues.",
    inputSchema: z.object({ query: z.string() }),
    handler: async ({ query }, { signal, workspace }) => {
      const response = await fetch(
        `https://jira.example/issues?q=${encodeURIComponent(query)}`,
        { signal },
      );
      return {
        type: "success",
        output: { workspace, issues: await response.json() },
      };
    },
  });

  jira.registerCommand({
    name: "open-issue",
    description: "Open a Jira issue.",
    handler: async ({ argument, workspace }) => {
      return `Opening ${argument} in ${workspace}`;
    },
  });
};

export default jiraPlugin;
```

Plugin Identifiers use lowercase ASCII letters, digits, and underscores; local Tool names also allow hyphens. Wincode exposes `plugin_jira_search_issues` to the Agent and uses `plugin:jira:search_issues` as the Tool Permission action. A custom permission action that collides with a host-native tool action is qualified under the Plugin Identifier (for example, `plugin:jira:edit`), so a native `edit: allow` rule cannot authorize a Plugin Tool; user rules can grant the Plugin-scoped action explicitly. A Plugin Tool's effective permission defaults to `ask` for each calling Agent. Only user-controlled rules may grant `allow`; project rules may tighten the decision to `ask` or `deny`. The normal Interactive approval flow applies, while Print and JSON Modes fail closed on an unresolved `ask`. RPC uses its existing approval protocol.

Plugin Tool handlers receive an `AbortSignal`; parallel calls may invoke handlers concurrently, so Plugins coordinate shared mutable state themselves. Tool input schemas may be Zod or JSON Schema. Handlers return the common Tool outcome shape: `{ type: "success", output }` or `{ type: "failure", errorText }`. Successful output is bounded to 64 KiB of UTF-8 text or JSON; failures become safe failed Tool Calls.

Tools can also be registered from `onSessionStart(context, scope)` or `onBeforeAgentTurn(context, scope)`. The pre-Turn context contains the Session ID, Agent ID, workspace, and abort signal. Within one Plugin, Turn registrations override Session registrations, which override factory registrations. A same-scope registration replaces that Plugin's previous definition; `unregisterTool(name)` masks an outer definition only in that scope. Other Plugins cannot replace its tools. A failed pre-Turn hook contributes no tools for that Plugin on the affected Turn.

Plugin Commands appear in the Interactive command menu and run only after a tracked menu selection. They receive the argument text, workspace, and optional Session identity, and their returned text is displayed to the user. Commands work before a Session is opened and do not pass through Tool Permission or open a second approval dialog.

A Plugin factory may also register named process resources with `registerResource(name, value)`. Host integrations retrieve them through the generic `PluginRuntime.getResource(pluginId, name)` API; resource types and ownership stay with the Plugin. Resource names are unique within a Plugin and values must be defined. The Plugin should release owned resources from `onShutdown`.

Tool handlers can register background promises with `context.registerBackgroundWork(promise)`. One-Shot waits for all work registered to that Session before exiting. Interactive Mode and RPC keep the parent Session Host alive while registered work is pending, even after its last view is released; normal idle unloading resumes when the work settles.

## Status Panels

Plugins may register a status panel with `registerStatusPanel`. The host renders its snapshot in the session sidebar and indicator, routes refresh and item actions through the Plugin Runtime, and lets a command open the same panel with `statusPanelId`. When a panel supplies `refresh`, its dialog exposes `Ctrl+R`; `Space` runs the selected item action. A panel owns its status values and action behavior; the host does not need domain-specific UI or imports.

## Session SDK

The public `createSessionSdk` API creates or reopens durable Sessions and returns caller-owned handles. `handle.deliver({ idempotencyKey, text })` durably queues an idempotent message and wakes the Session at its next safe boundary; `handle.prompt(input)` also permits Agent/model selection. SDK callers select Plugins with explicit `pluginPaths`; the child does not inherit the parent's selected or file-loaded Plugin paths. For example, Subagents selects its own source so a child can submit its result:

```ts
const childSdk = await parentSdk.createChildSdk({
  pluginPaths: [subagentsPluginPath],
});
const child = await childSdk.openSession(childSessionId);
```

The Wincode distribution selects MCP and Subagents packages by default for application entry points. Direct SDK callers choose the packages they need by resolving their `@wincode/mcp/plugin` or `@wincode/subagents/plugin` entry points to explicit paths.

Dispose child handles and child SDKs when their work is complete. Coding and shell remain native Session tools; Skills remain native host capabilities.

## Lifecycle

The default factory runs once per Wincode process. A Plugin may register one `onSessionStart`, `onSessionShutdown`, `onBeforeAgentTurn`, and `onShutdown` hook. Session hooks follow each loaded Session runtime: when an idle runtime unloads and later reopens, Wincode sends a new start/shutdown pair. A failed start disables the Plugin only for that Session; a failed pre-Turn hook omits that Plugin's tools only for the affected Turn. Cleanup hooks are idempotent. Plugin file changes take effect on the next Wincode start; hot reload is not supported.
