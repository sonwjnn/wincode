# Reusable TUI and Plugin UI

Status: accepted design; implementation pending.

Decision: [ADR-0058](../adr/0058-reusable-react-tui-and-host-mediated-plugin-ui.md).

## Problem and scope

Coding-Agent's Interactive Mode uses OpenTUI and React, but its shared components depend on application-local providers. Plugins currently contribute declarative status panels and host-owned text input, not arbitrary React UI. Extracting files alone would not provide a public Plugin UI contract or support independent applications.

Create `@wincode/tui` for Coding-Agent, Plugins, and independent terminal applications. Use OpenTUI and React; do not build the `Component.render(width)` framework from [tui.md](../research/tui.md).

The scope is the complete UI surface of [plugin.md](../research/plugin.md), adapted to React and current Session contracts. That file and `tui.md` are reference inputs, not documentation of a shipped `@wincode/tui` package. Where they differ, this design governs. This work does not copy the reference's non-UI Plugin registration, event system, message-writing APIs, or storage model.

## Naming

### Canonical names

| Concept | Name | Meaning |
| --- | --- | --- |
| Reusable package | `@wincode/tui` | OpenTUI + React UI library, not the Coding-Agent application |
| Package directory | `packages/tui/` | Planned workspace location for the reusable library |
| Application package | `@wincode/coding-agent` | Owns application composition and Execution Modes |
| Application terminal interface | **Interactive Mode** | Use the existing glossary term, not “Wincode TUI” or “TUI application” |
| Plugin contribution boundary | **PluginAPI** | Existing public contract; Plugin UI extends it rather than creating a parallel Plugin SDK |
| Plugin presentation | **Plugin UI** | Host-mediated presentation contributed by a Plugin |
| Interactive request | **Plugin UI Request** | Has its own lifetime, distinct from an Agent Turn |
| Custom interaction API | `ctx.ui.custom()` | React-based temporary interaction; not a terminal handoff |
| Completion callback | `done(value)` | Settles that interaction with its result |
| Renderer delegation | `next()` | Continues the presentation override chain |
| Global theme change | `ctx.ui.setTheme()` | Explicitly changes the shared application theme |

Use **editor replacement**, **overlay**, and **full screen** for the three custom UI presentation modes. Use **custom editor** only for replacing/wrapping the prompt editor itself. A **UI host** coordinates rendering and interaction; it is not the **Session Host**, which owns application-level Session composition.

### Export and implementation names

Keep reusable UI names application-neutral. Session/Agent/Plugin-specific adapters belong in Coding-Agent, not in generic component names or imports from `@wincode/tui`. Use React component and hook naming rather than recreating the imperative `Component.render(width)` abstraction.

`TUI`, `ProcessTerminal`, `TuiMainScreen`, and `TuiAltScreen` in `tui.md` are reference-framework names, not promised exports. Likewise, `CustomEditor` in `plugin.md` is not a requirement to introduce a React base class.

Exact public component, hook, factory, options, error-class, and RPC capability names remain to be defined against the installed OpenTUI types. The implementation API inventory must record each exported name, its owning package/import path, and any reference API it replaces before examples are published. This document does not reserve speculative TypeScript names or promise compatibility with the imperative references.

## Ownership and package boundary

| Owner | Responsibilities |
| --- | --- |
| `@wincode/tui` | Reusable React components, theme facilities, dialogs, focus and keybinding coordination, and UI-host construction for independent applications |
| Coding-Agent | Interactive Mode composition, the single renderer and React root, Session/view integration, Plugin UI admission, contribution ownership, and RPC UI bridge |
| Plugin | React content and local interaction logic, registered through the public PluginAPI |
| Independent application | Its own renderer/UI host and application lifecycle, without loading Coding-Agent |

`@wincode/tui` imports neither Coding-Agent nor concrete Plugins. Agent execution, persistence, permissions, routing policy, and Session-specific views remain application concerns. The reusable package supplies UI mechanisms; Coding-Agent supplies the host policy described below.

Plugin-facing UI-neutral contracts stay accessible without importing React or OpenTUI at runtime. Interactive rendering is composed only for Interactive Mode; RPC, JSON, Print, and help/version retain their noninteractive dependency boundaries. Exact exports and peer-dependency declarations must be verified against OpenTUI's installed types during implementation.

This extraction does not restore the former `@wincode/tui` application package or move the executable out of Coding-Agent.

## Custom UI

### Component contract

`ctx.ui.custom()` accepts a React-based component factory with access to the host theme, configured keybindings, an `AbortSignal`, and `done(value)`. The host provides the rendering environment and relevant terminal dimensions without transferring renderer or terminal lifecycle ownership.

Support three presentation modes:

- **Editor replacement:** temporarily replace the composer region; keep the transcript visible and restore the previous editor afterward.
- **Overlay:** present a component over existing content with host-managed placement, sizing, visibility, focus, and bounds.
- **Full screen:** replace the visible application content within the existing renderer, then restore it on completion.

The reference's async factory behavior remains in scope. A factory resolving after cancellation must not mount stale UI. The exact React factory signature is an implementation detail; its lifecycle and outcomes are fixed below.

### Admission and concurrency

An explicit user Plugin Command may request custom UI directly. An event-originated request first creates a notification/invitation; every request requires user acceptance before mounting or taking focus. Consent is not remembered for later requests. The host determines invocation provenance; a Plugin does not bypass consent by labeling an event as a command.

There is one active custom UI interaction per Interactive UI host. A competing custom UI request fails with a coded `busy` error; custom UI does not nest or queue behind another custom UI. Admission includes the host-owned invitation so competing requests cannot accumulate a deferred opening queue.

Agent Turns and Tools continue while custom UI is visible. Host state keeps updating, and the restored application shows the latest state. Waiting for Plugin UI is not evidence that the Agent has paused. Prompt lifecycle notifications describe the interaction, not Agent execution state.

### Results and errors

The public result is `Promise<T | undefined>`.

| Outcome | Result |
| --- | --- |
| `done(value)` | Resolve with `value` |
| Ordinary dismissal | Resolve `undefined` |
| Host cancellation | Resolve `undefined` |
| User declines an event-originated request | Resolve `undefined` |
| Mode or client cannot support custom components | Resolve `undefined` |
| Another custom UI owns admission | Reject with a coded `busy` error |
| Factory/component execution failure | Reject with a coded execution error |

`undefined` carries no outcome taxonomy and cannot distinguish dismissal, cancellation, refusal, or unsupported mode. Plugins needing a meaningful successful answer should use a non-undefined value. Error codes must be public and stable; exact names are defined with the implementation contract.

Every request settles once. Completion, cancellation, and failure release its resources and admission; repeated or late `done()` calls cannot affect a later request.

### Lifecycle and input

Cancel the request when its owning Session/view is replaced, its Plugin is reloaded/unloaded, or the renderer shuts down. Cancellation aborts the supplied signal, unmounts the component, releases listeners/subscriptions, and restores valid prior focus and composer state. Agent Turn completion or interruption alone does not cancel the UI.

The host retains reserved system actions, including a way to dismiss/reclaim Plugin UI. Focused Plugin components receive local input before ordinary application shortcuts, but cannot consume reserved host actions. The concrete reserved keybindings must integrate with the existing host keyboard layers rather than introduce an unrelated shortcut scheme.

Components must support keyboard-only operation, visible interaction hints, resize, and narrow terminals. Overlay geometry is constrained to the available terminal region. Full-screen content still participates in host cancellation and focus restoration.

## Other Plugin UI surfaces

All categories below are in scope; delivery may be incremental, but implementing `custom()` alone is not completion of this design.

| Surface | Required adaptation |
| --- | --- |
| Dialogs and notifications | Selection, confirmation, input, multiline editor, and nonblocking notification; preserve the reference's dismissal, timeout, and caller-abort behavior |
| Prompt lifecycle | Start/end notifications around blocking interactions, with overlapping spans coalesced; best-effort observers must not prevent opening or closing |
| Composer access | Read/set text and paste through normal composer handling |
| Autocomplete | Plugin contributions compose with slash/path completion and command argument completion |
| Status and widgets | Keyed status and widgets, above/below composer placement, working text/visibility/indicator |
| Header and footer | Host-mediated React replacements with clear ownership and cleanup |
| Custom editor | Replace or wrap the prompt editor while preserving host submit/history/keybinding integration; distinct from temporary custom UI |
| Presentation controls | Terminal title, hidden-thinking label, and tool expansion state |
| Themes | List/load/switch shared themes and consume reactive theme values |
| Tool rendering | React renderers for calls/results, row context and state, updates, shell ownership, and fallback |
| Message and entry rendering | React presentations for current transcript/history data; presentation does not change model-context inclusion |
| Markdown transforms | Ordered display-only transformation on the reference's applicable surfaces; errors preserve prior successful output |
| Input and shortcuts | Registered shortcuts and Interactive-only raw input subscriptions, subject to host system-key precedence |

Reference dialog defaults remain: select/input timeout returns `undefined`; confirm timeout returns `false`. Preserve caller-abort observability without extending the custom UI result into an outcome union.

### Contribution ownership

Qualify keyed widgets/status and their cleanup by Plugin Identifier; identical local keys in different Plugins do not overwrite each other. Use deterministic contribution ordering.

Each Session's editor slot, plus the application-host-wide header and footer slots, has one active owner. The first successful registration claims the position; a second Plugin in that scope receives a conflict rather than silently replacing it. Releasing/unloading the owner restores the host default. Wrapping an editor does not create an implicit stack of competing Plugin owners.

Subscriptions, raw input handlers, widgets, and presentation overrides are tied to their owning Plugin and applicable Session/view scope. Reload/unload removes them without leaving stale callbacks active.

### Theme behavior

Components inherit the shared reactive theme and update when it changes. Local style overrides affect only the component subtree, not the application's theme. An explicit `setTheme()` changes the shared application theme, as in the reference; loading/switching an invalid theme reports failure rather than corrupting the active theme.

### Renderer overrides

Plugins may override presentation of host or other Plugin tools/messages/entries. A resolver chain supports `next()`:

1. Higher priority runs first.
2. Equal priority follows stable registration order.
3. Delegation or declining to handle continues to the next resolver.
4. A rendering failure falls back through remaining resolvers to the host default, with diagnostics kept out of terminal/protocol output.

React rendering failures require a host-managed recovery boundary; a factory-only try/catch is not sufficient. Isolate presentation failure from Tool execution and durable Session data.

Override authority is presentation-only. It does not transfer contribution ownership, allow writes to another Plugin's history, grant Tool Permission, or alter model input. Message/entry renderers use current Session Transcript and Plugin Session History contracts, not new `sendMessage()`/`appendEntry()` persistence paths. History navigation and missing/disabled Plugins must retain existing history and opaque-payload guarantees.

## Execution Modes and RPC

| Mode | Behavior |
| --- | --- |
| Interactive | Full React UI surface through the application's UI host |
| RPC | Supported dialogs and notifications use a capability-negotiated data protocol; custom React UI returns `undefined`, and component factories are ignored |
| JSON / Print | No interactive UI; follow reference no-op/default behavior and keep structured/human output clean |

RPC clients declare UI capability. Unsupported requests complete immediately with an unsupported/default outcome rather than waiting indefinitely. No mode loads or serializes Plugin React components to service an RPC request.

The existing RPC protocol has no Plugin UI bridge. Implementation must specify request correlation, responses, cancellation, connection loss, ordering, and capability negotiation against the current protocol before claiming RPC UI support. Noninteractive no-op/default mappings for each API must be explicit in that contract. UI capability does not bypass existing permission settlement rules.

## Delivery and acceptance

This is a documentation-only decision. No package, API, renderer extraction, or RPC change is implemented by it.

Implementation sequence:

1. Establish the reusable package and dependency boundary; prove independent application startup and Coding-Agent consumption.
2. Extract reusable UI/provider mechanisms while retaining the single renderer through startup and exit.
3. Add host-mediated custom UI, admission, cancellation, input arbitration, and React error recovery.
4. Add the remaining UI contributions and renderer chains against current Session contracts.
5. Add capability-negotiated RPC UI and explicit per-mode result mappings.
6. Update authoring documentation and replace imperative reference examples with verified React examples.

Tests must defend observable contracts, including:

- An independent application uses `@wincode/tui` without importing Coding-Agent; the package has no reverse dependency on it.
- Startup trust, application UI, and all custom presentation modes share one renderer; returning restores the prior composer/focus and current Session state.
- Event-originated requests never mount without acceptance; a competing request rejects busy; decline releases admission.
- Completion, abort, late async factory resolution, and rendering failure settle once and release resources without stale remounts.
- Agent progress continues while custom UI is open; UI waiting does not masquerade as a paused Agent Turn.
- Reserved host keys remain reachable, local key precedence is consistent, and resize/keyboard-only operation works in all three presentation modes.
- Owner conflicts leave the current editor/header/footer intact; Plugin unload removes only that Plugin's keyed contributions and restores defaults.
- Priority, registration ties, `next()`, and render failure produce deterministic fallback without modifying execution or stored history.
- Theme changes propagate; local overrides remain local; invalid global changes preserve the active theme.
- RPC capability absence/disconnect cannot strand a request; JSON/Print/RPC execution does not load React or emit terminal control output.

Use renderer-level contract tests plus controlled Interactive Mode checks. Do not describe the complete Plugin UI surface as shipped until both terminal and per-mode contracts are verified.

## Related decisions

- [ADR-0027: Coding-Agent application modes](../adr/0027-coding-agent-application-modes.md) — application ownership and React-free noninteractive execution; reusable library placement revised by ADR-0058.
- [ADR-0039: Unified Plugin registration](../adr/0039-unified-plugin-registration.md) — public contribution ownership and lifecycle.
- [ADR-0051: Single renderer across startup](../adr/0051-single-renderer-across-interactive-startup.md) — terminal and React root ownership.
- [ADR-0056: Session history tree and Plugin entries](../adr/0056-session-history-tree-and-plugin-entries.md) — history semantics remain separate from presentation.
