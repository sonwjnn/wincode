# File-loaded Plugins

File-loaded Plugins are trusted TypeScript modules that Wincode explicitly loads into its process. They can register model-visible Agent Tools and Interactive Mode commands through the public `@wincode/coding-agent` API.

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

A project config may name explicit Plugin paths, but Wincode considers them only after the project has been trusted; a `.wincode/plugins/` directory is never discovered implicitly. Relative paths resolve against the config file that declares them. When Plugin Identifiers collide, the source-class precedence decides which Plugin loads first; CLI paths win ties with user configuration. Wincode accepts TypeScript paths (`.ts`, `.tsx`, `.mts`, `.cts`) and reports invalid, missing, or failed Plugins without preventing other Plugins from loading.

Enabling a path is a trust decision: Plugin code runs with Wincode's process privileges, including code executed while the module loads. Plugins are not sandboxed, and Wincode does not install their dependencies. Local imports and dependencies already available to the Plugin may be used. `--no-plugin <id>` and configured `disabledPlugins` entries disable known default/distribution Plugins before loading them; they do not disable explicitly selected file paths. Remove a file path from the CLI or the configuration source that declares it to stop that Plugin from loading.

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

Plugin Identifiers use lowercase ASCII letters, digits, and underscores; local Tool names also allow hyphens. Wincode exposes `plugin_jira_search_issues` to the Agent. The owner-qualified Plugin name prevents collisions but has no authorization meaning. Registered Plugin Tools execute without a Wincode per-call allow/deny decision; explicitly enabling Plugin code is the trust boundary. Project-selected Plugins are considered only after Project trust has been granted.

Plugin Tool handlers receive an `AbortSignal`; parallel calls may invoke handlers concurrently, so Plugins coordinate shared mutable state themselves. Tool input schemas may be Zod or JSON Schema. Handlers return the common Tool outcome shape: `{ type: "success", output }` or `{ type: "failure", errorText }`. Successful output is bounded to 64 KiB of UTF-8 text or JSON; failures become safe failed Tool Calls.

Tools can also be registered from `onSessionStart(context, scope)` or `onBeforeAgentTurn(context, scope)`. The pre-Turn context contains the Session ID, Agent ID, workspace, and abort signal. Within one Plugin, Turn registrations override Session registrations, which override factory registrations. A same-scope registration replaces that Plugin's previous definition; `unregisterTool(name)` masks an outer definition only in that scope. Other Plugins cannot replace its tools. A failed pre-Turn hook contributes no tools for that Plugin on the affected Turn.

Plugin Commands appear in the Interactive command menu and run only after a tracked menu selection. They receive the argument text, workspace, and optional Session identity, and their returned text is displayed to the user. Commands work before a Session is opened; selecting one from the command menu is its explicit execution intent.

A Plugin factory may also register named process resources with `registerResource(name, value)`. Host integrations retrieve them through the generic `PluginRuntime.getResource(pluginId, name)` API; resource types and ownership stay with the Plugin. Resource names are unique within a Plugin and values must be defined. Open process resources in `onStart` and release them from `onShutdown`; factories should register behavior without opening connections or acquiring process-wide resources. Runtime shutdown calls `onShutdown` only after that Plugin's `onStart` was attempted, including when startup fails so partially initialized resources can be released.

Tool handlers can register background promises with `context.registerBackgroundWork(promise)`. One-Shot waits for all work registered to that Session before exiting. Interactive Mode and RPC keep the parent Session Host alive while registered work is pending, even after its last view is released; normal idle unloading resumes when the work settles.

## Status Panels

Plugins may register a status panel with `registerStatusPanel`. The host renders its snapshot in the session sidebar and indicator, routes refresh and item actions through the Plugin Runtime, and lets a command open the same panel with `statusPanelId`. When a panel supplies `refresh`, its dialog exposes `Ctrl+R`; `Space` runs the selected item action. A panel owns its status values and action behavior; the host does not need domain-specific UI or imports.

## Session SDK

The public `createSessionSdk` API creates or reopens durable Sessions and returns caller-owned handles. `handle.deliver({ idempotencyKey, text })` durably queues an idempotent message and wakes the Session at its next safe boundary; `handle.prompt(input)` also permits Agent/model selection. SDK callers select Plugins with explicit `pluginPaths`; the child does not inherit the parent's selected or file-loaded Plugin paths. For example, Subagents selects its own source so a child can submit its result:

```ts
const childSdk = await parentSdk.createSessionRuntime({
  pluginPaths: [subagentsPluginPath],
});
const child = await childSdk.openSession(childSessionId);
```

The Wincode distribution selects MCP and Subagents packages by default for application entry points. Direct SDK callers choose the packages they need by resolving their `@wincode/mcp/plugin` or `@wincode/subagents/plugin` entry points to explicit paths.

Dispose child handles and child SDK runtimes when their work is complete. Coding and shell remain native Session tools; Skills remain native host capabilities.

## Lifecycle

The factory runs when its Plugin runtime is built: once at startup, and again when `/reload` replaces that runtime. A Plugin may register one `onStart`, `onSessionStart`, `onSessionShutdown`, `onBeforeAgentTurn`, and `onShutdown` hook. `onStart` and `onShutdown` bracket process resources and may run more than once during a Wincode process; they must safely initialize and release those resources on each cycle. Session hooks follow each loaded Session runtime: when an idle runtime unloads and later reopens, Wincode sends a new start/shutdown pair. A failed process start disables that Plugin in the candidate runtime; a failed Session start disables it only for that Session; a failed pre-Turn hook omits that Plugin's tools only for the affected Turn. Cleanup hooks are idempotent.

Interactive `/reload` re-resolves Project trust and reloads file-backed Plugins after every Session Host is idle. Wincode tears down the active Plugin process resources before starting replacements. If a replacement process hook fails and Project trust did not change, it restores the previous Plugin runtime. On a trust change, it does not restore Plugins that may have come from newly untrusted project resources. Built-in keybindings are currently compiled into Wincode, so `/reload` does not change them.
