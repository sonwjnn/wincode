# File-loaded Plugins

File-loaded Plugins are trusted TypeScript modules that Wincode explicitly loads into its process. They can register model-visible Agent Tools and Interactive Mode commands through the public `@wincode/coding-agent` API.

## Enable a Plugin

A Plugin file in `.wincode/plugins/` is **not** loaded just because Wincode opens that workspace. Enable it for one run with a repeatable CLI option:

```sh
wincode --plugin .wincode/plugins/jira.ts
```

CLI-relative paths resolve from the workspace. To enable a Plugin on every run, add an absolute path to `~/.wincode/settings.json`:

```json
{
  "plugins": ["/Users/alex/project/.wincode/plugins/jira.ts"]
}
```

A project config may name explicit Plugin paths, but Wincode considers them only after the project has been trusted; a `.wincode/plugins/` directory is never discovered implicitly. Relative paths resolve against the config file that declares them. When Plugin Identifiers collide, the source-class precedence decides which Plugin loads first; CLI paths win ties with user configuration. Wincode accepts TypeScript paths (`.ts`, `.tsx`, `.mts`, `.cts`) and reports invalid, missing, or failed Plugins without preventing other Plugins from loading.

Plugins own and manage their durable data and integration-specific credentials outside the Provider SDK and MCP OAuth contracts. The generic host-managed `plugin.secrets` API is not exposed. `PluginLoadContext.userDataDir` is the shared per-user data root, not a private directory per Plugin; use a namespaced child such as `plugins/<plugin-id>` for Plugin-owned files, or an external secret manager for credentials. If a Plugin writes sensitive files, it is responsible for restrictive permissions and safe writes. Provider SDK credentials remain application-managed in `auth.json`, and MCP OAuth uses the dedicated MCP secret store. Plugins are trusted code with the process's OS privileges and are not sandboxed.

Breaking change: `PluginDefinitionAPI.secrets` and `PluginSecretStore` have been removed. Values in the former `plugin-secrets` files or platform secret store are not imported or automatically deleted; affected Plugins must migrate and re-authenticate.

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

### Provider SDK Providers

A trusted Plugin may register a custom SDK Provider with `registerProvider`. The host calls `createProvider()` for each Session Host, so return a fresh Provider instance. The `connect` interaction receives only the host's `requestTextInput` operation and an abort signal, then returns a JSON credential value or `undefined` to cancel:

```ts
plugin.registerProvider({
  providerId: "acme",
  displayName: "Acme Model Service",
  createProvider: () => createAcmeProvider(),
  connect: async ({ requestTextInput, signal }) => {
    const apiKey = await requestTextInput("Acme API key", signal);
    return apiKey === undefined ? undefined : { apiKey };
  },
});
```

The Plugin supplies Provider behavior and its connect interaction; Wincode owns persistence. Plugin code receives no CredentialStore API and cannot look up stored credentials by Provider ID. At invocation, the SDK supplies only the credential stored for that registration's Plugin ID and canonical trusted source identity. The same owner identity scopes Known Model snapshots; a different source must connect again, and records for an absent Plugin remain quarantined. Provider IDs colliding with built-ins or another Plugin are rejected.

Plugin Tool handlers receive an `AbortSignal`. Calls within a Model Step run concurrently by default (`executionMode: "parallel"`, or omitted). Declare `executionMode: "sequential"` on a Tool that reads and modifies shared state: if any Tool in the batch requests sequential execution, the entire batch runs in model-emitted order, awaiting each handler before starting the next. This includes awaited work in the handler; read current state inside the handler, not before scheduling. Cancellation prevents remaining sequential calls from starting; an ordinary Tool failure does not skip siblings.

`exclusiveInBatch: true` has a different meaning: the Tool must be the only call in its Model Step. A mixed batch containing an exclusive Tool is rejected before any handler runs, even if a Tool requests sequential execution. Sequential scheduling is not a global Plugin lock or a transaction: it does not coordinate Plugin Commands, background callbacks, other Sessions, or snapshots prepared earlier. Plugins must coordinate those writers themselves; earlier successful effects are not rolled back. Tool input schemas may be Zod or JSON Schema. Handlers return the common Tool outcome shape: `{ type: "success", output }` or `{ type: "failure", errorText }`. Successful output is bounded to 64 KiB of UTF-8 text or JSON; failures become safe failed Tool Calls.

Tools can also be registered from `onSessionStart(context, scope)` or `onBeforeAgentTurn(context, scope)`. The pre-Turn context contains the Session ID, Agent ID, workspace, and abort signal. Within one Plugin, Turn registrations override Session registrations, which override factory registrations. A same-scope registration replaces that Plugin's previous definition; `unregisterTool(name)` masks an outer definition only in that scope. Other Plugins cannot replace its tools. A failed pre-Turn hook contributes no tools for that Plugin on the affected Turn.

Plugin Commands appear in the Interactive command menu and run only after a tracked menu selection. They receive the argument text, workspace, and optional Session identity, and their returned text is displayed to the user. Commands work before a Session is opened; selecting one from the command menu is its explicit execution intent.

### Prompt selection

The root `PluginAPI` exposes `setModel(model)` and `setThinkingLevel(level)` for the focused Interactive composer. They change the effective selection for future Submissions, taking precedence over model and ThinkingLevel defaults on the selected Agent while preserving the Agent's identity, instructions, and tools. They do not change an in-flight Agent Turn or configured defaults for new Wincode processes. On an actual model change, Thinking Level starts at `low` when supported; otherwise the host searches higher supported levels first, then lower ones. `Off` is an explicit level and may be the final fallback if declared. `setModel` returns `false` when there is no Interactive composer, the model is unsupported or retired, or its Connection Provider is not connected. Thinking-level requests are checked against the effective model; unsupported non-`undefined` levels are ignored. Pass `undefined` to use the provider default, including when the Agent has a configured ThinkingLevel. Outside Interactive Mode, `setModel` returns `false` and `setThinkingLevel` has no effect.

These controls are process-global and target the currently focused composer, not an arbitrary Session Host. A Plugin that needs to change a model for a future turn can call them from a user-invoked Plugin Command or another Plugin callback while the Interactive composer is active.

A Plugin factory may also register named process resources with `registerResource(name, value)`. Host integrations retrieve them through the generic `PluginRuntime.getResource(pluginId, name)` API; resource types and ownership stay with the Plugin. Resource names are unique within a Plugin and values must be defined. Open process resources in `onStart` and release them from `onShutdown`; factories should register behavior without opening connections or acquiring process-wide resources. Runtime shutdown calls `onShutdown` only after that Plugin's `onStart` was attempted, including when startup fails so partially initialized resources can be released.

Tool handlers can register background promises with `context.registerBackgroundWork(promise)`. One-Shot waits for all work registered to that Session before exiting. Interactive Mode and RPC keep the parent Session Host alive while registered work is pending, even after its last view is released; normal idle unloading resumes when the work settles.

## Status Panels

Plugins may register a status panel with `registerStatusPanel`. The host renders its snapshot in the session sidebar and indicator, routes refresh and item actions through the Plugin Runtime, and lets a command open the same panel with `statusPanelId`. When a panel supplies `refresh`, its dialog exposes `Ctrl+R`; `Space` runs the selected item action. A panel owns its status values and action behavior; the host does not need domain-specific UI or imports.

## Session SDK

The public `createSessionSdk` API creates or reopens durable Sessions and returns caller-owned handles. `handle.deliver({ idempotencyKey, text })` durably queues an idempotent message and wakes the Session at its next safe boundary; `handle.prompt(input)` also permits Agent/model selection. SDK callers select file-backed Plugins with explicit `pluginPaths` or supply host-owned Plugin factories through `pluginFactories`; the child inherits neither selection automatically. Subagents supplies its own factory so a child can submit a result:

```ts
const childSdk = await parentSdk.createSessionRuntime({
  pluginFactories: [{ factory: subagentsPluginFactory, id: "subagents" }],
});
const child = await childSdk.openSession(childSessionId);
```

The Wincode distribution includes MCP and Subagents factories by default for application entry points. Direct SDK callers select only the Plugins they need.

Dispose child handles and child SDK runtimes when their work is complete. Coding and shell remain native Session tools; Skills remain native host capabilities.

## Portable Plugin state

A Plugin that stores small, declarative state about one conversation can opt in with `sessionStateVersion`. Wincode exposes a Session-bound `sessionState` capability in Session lifecycle hooks, pre-Agent-Turn and compaction contexts, Plugin Tool contexts, and Session-bound Plugin Command contexts. Factory/process contexts do not receive it; a command without a loaded Session continues to work without persistent state. The capability is bound to the current Plugin Identifier and Session, and exposes only `read(key)`, `set(key, value, operationId)`, and `delete(key, operationId)`.

```ts
const jira = api.definePlugin({ id: "jira", sessionStateVersion: 1 });

jira.onSessionStart(async ({ sessionState }) => {
  if (sessionState === undefined) return;
  const plan = await sessionState.read("plan");
  if (plan.kind === "value") {
    // Use plan.value in Plugin logic; reads do not add it to model context.
  }
});

jira.registerTool({
  name: "record_plan",
  description: "Record the current Jira investigation plan.",
  inputSchema: z.object({ issue: z.string() }),
  handler: async ({ issue }, { sessionState, toolCallId }) => {
    if (sessionState === undefined) {
      return { type: "failure", errorText: "No Session is active." };
    }
    await sessionState.set(
      "plan",
      { issue, status: "investigating" },
      `plan-${new Bun.CryptoHasher("sha256").update(toolCallId).digest("hex")}`,
    );
    return { type: "success", output: { recorded: true } };
  },
});
```

For a complete executable example, see [the checklist Plugin](../../examples/checklist-plugin.ts). It validates restored data without replaying actions, reads the latest checklist inside a sequential handler, and commits each change before returning success. Enable it explicitly with `wincode --plugin packages/coding-agent/examples/checklist-plugin.ts` from the repository root. Persist when state changes, not only in `onSessionShutdown`: a crash need not run cleanup hooks. The example has no shutdown writes, task replay, or operational ownership transfer.

Operation IDs must contain at most 512 ASCII characters, start with a letter or digit, and otherwise contain only letters, digits, `.`, `_`, or `-`. Hashing an opaque Tool Call ID produces a stable safe identifier; do not interpolate arbitrary IDs containing `:` or `/` directly. Retry with the same operation ID **and payload**. A rejected indeterminate write is not proof that nothing committed; keep the Session blocked until storage reconciliation, and do not invent a new operation ID to retry uncertain work.

Values must be strict JSON and no larger than 64 KiB; keys are non-empty and at most 256 UTF-8 bytes. `read` returns `absent` for missing or deleted keys and `value` even when the stored JSON is `null`; an incompatible stored version returns `incompatible` with its version. `set` and `delete` reject an incompatible stored version with `PluginSessionStateVersionError`; Wincode does not automatically migrate or discard unknown state. Use a stable operation ID and the same payload when retrying a write.

Session Bundles retain these entries. A Session Fork inherits only the effective state in the JSONL prefix ending at its selected Session Record: a state event appended after that Record is excluded, even if it was written during the same Agent Turn. Replacement and deletion append entries; they do not erase old payloads from the log, so this capability is not for secrets and deletion is not secure erasure. Plugin state never enters Session Context automatically and does not imply replay, task ownership transfer, or availability of external resources.

## Plugin Session History

Use `sessionHistory` for Plugin-owned events whose meaning depends on the Session branch. It is available in Session lifecycle hooks, pre-Agent-Turn and compaction hooks, Plugin Tool contexts, and Plugin Command contexts when a Session is loaded. `onBeforeSessionHistoryNavigation` receives a read-only reader; `onSessionHistoryNavigated` receives the new capability after the durable path change. Factory/process contexts and commands without a loaded Session do not receive it.

```ts
const checklist = api.definePlugin({ id: "checklist_history" });

checklist.onSessionStart(async ({ sessionId, sessionHistory }) => {
  if (sessionHistory === undefined) return;
  // Reduce the Selected Path to restore this Session's in-memory projection.
});

checklist.onSessionHistoryNavigated(async ({ sessionId, sessionHistory }) => {
  if (sessionHistory === undefined) return;
  // Rebuild the projection from the newly Selected Path; do not replay actions.
});

checklist.registerTool({
  name: "add_item",
  description: "Add an item to this Session's checklist.",
  inputSchema: z.object({ item: z.string() }),
  handler: async ({ item }, { sessionHistory, toolCallId }) => {
    if (sessionHistory === undefined) {
      return { type: "failure", errorText: "No Session is active." };
    }
    const operationId = new Bun.CryptoHasher("sha256")
      .update(toolCallId)
      .digest("hex");
    await sessionHistory.append(
      "item-added",
      { schemaVersion: 1, item },
      `checklist-add-${operationId}`,
    );
    return { type: "success", output: { recorded: true } };
  },
});
```

`read({ cursor, limit })` returns only this Plugin's events on the Selected Path. Pages default to 50 entries, with a maximum of 200, and include an opaque `readPoint`; keep following `nextCursor` to read that same snapshot. The Session tree reader is separate: use `sessionSdk.readSessionHistoryTreePage` only when the Plugin explicitly needs tree metadata. Tree entries show the Plugin Identifier and event type, never the payload. Custom events are not added to Provider context automatically.

`append(type, payload, operationId)` attaches one entry to the current Active Leaf and advances it as one durable history write. Event types must be non-empty and no more than 128 UTF-8 bytes. Payloads must be strict JSON and no more than 64 KiB serialized; the event type and payload schema version belong to the Plugin. Use a version field in payloads and leave unknown versions unapplied while preserving their original entries. Operation IDs follow the same 512-character ASCII format as Plugin Session State: retry with the same ID and identical event; reusing an ID with different content conflicts. A capability from before Navigation is stale; use the refreshed capability from `onSessionHistoryNavigated` or the next `onSessionStart`.

A failed append throws `PluginSessionHistoryWriteError`, whose `writeOutcome` distinguishes a write that did not commit from an indeterminate or committed-but-blocked write. Do not retry uncertain work with a new ID; keep the Session blocked until storage reconciliation. Validation errors occur before persistence. Events remain opaque and preserved when the Plugin is absent or disabled, and are retained in Session Bundles and Fork history. They are not secure-erasure storage. `sessionHistory` event history and `sessionState` snapshots are separate capabilities and may coexist.

For a complete example with pagination, schema validation, selected-branch restoration, and idempotent Tool writes, see [the event-backed checklist Plugin](../../examples/checklist-history-plugin.ts). Enable it explicitly with `wincode --plugin packages/coding-agent/examples/checklist-history-plugin.ts` from the repository root.

## Compaction hooks

Compaction runs under Session Host authority. Plugins observe it through three bounded hooks:

- `onBeforeCompaction(context)` runs once before a summary request. Returning `{ cancel: reason }` refuses that compaction; returning `{ summary: text }` supplies the handoff instead of calling a summary model. Returning nothing leaves compaction to the host.
- `onCompactionCompleted(context)` reports a durable compaction by identifier, `tokensBefore` and `estimatedTokensAfter`.
- `onCompactionFailed(context)` reports the safe failure message of a compaction that did not persist.

The context carries `sessionId`, `workspace`, `trigger` (`manual`, `threshold` or `overflow`), `signal`, and optional `focus`/`turnId`. A Plugin never receives transcript text, chooses a cut boundary, changes a token budget, or writes a compaction entry. Plugin-supplied summaries still pass host validation: empty text or text above the effective output-token budget fails before persistence, and the normal reduction and safe-threshold checks still apply. Generated Provider summaries do not require provider-enforced output limits: subscription routes such as OpenAI OAuth omit unsupported caps. The Host accepts nonempty output with explicit completion evidence even if its estimated or reported length exceeds the planned output budget, but the resulting compaction must still pass the normal reduction and safe-threshold checks. An unknown or unauthenticated configured target still fails instead of being masked by a handoff. The first Plugin that cancels wins and later Plugins are not consulted; a thrown hook is logged and the next Plugin may still decide.

## Lifecycle

The factory runs when its Plugin runtime is built: once at startup, and again when `/reload` replaces that runtime. A Plugin may register one `onStart`, `onSessionStart`, `onSessionShutdown`, `onBeforeAgentTurn`, `onBeforeCompaction`, `onCompactionCompleted`, `onCompactionFailed`, and `onShutdown` hook. `onStart` and `onShutdown` bracket process resources and may run more than once during a Wincode process; they must safely initialize and release those resources on each cycle. Session hooks follow each loaded Session runtime: when an idle runtime unloads and later reopens, Wincode sends a new start/shutdown pair. A failed process start disables that Plugin in the candidate runtime; a failed Session start disables it only for that Session; a failed pre-Turn hook omits that Plugin's tools only for the affected Turn; a failed compaction hook is logged and never fails or rolls back a compaction. Cleanup hooks are idempotent.

Interactive `/reload` re-resolves Project trust and reloads file-backed Plugins after every Session Host is idle. Wincode tears down the active Plugin process resources before starting replacements. If a replacement process hook fails and Project trust did not change, it restores the previous Plugin runtime. On a trust change, it does not restore Plugins that may have come from newly untrusted project resources. Built-in keybindings are currently compiled into Wincode, so `/reload` does not change them.
