# Reusable TUI composition coverage audit

This records the #306 coverage audit of the exact #298 issue scope after its implementation slices were integrated. That scope accounts for the five UI families in #298; it does not claim the broader Plugin UI surface in the accepted `docs/plans/reusable-tui-and-plugin-ui.md` or ADR-0058 is complete.

## Family coverage

| Family | Shared composition and paired consumers | Host-owned behavior and remaining work |
| --- | --- | --- |
| Dialogs and overlays | Public `DialogFrame` is used by Coding-Agent's `DialogProvider` and the independent `packages/tui/examples/prompt-flow.tsx`; `InputDialog` and `ConfirmDialog` are used by Coding-Agent's Plugin UI (`plugin-text-input-dialog.tsx`, `plugin-ui-host.tsx`) and the same independent flow. | The shared frame bounds and clips the shell but is not a scrolling viewport; hosts retain long-content viewports and fixed action/hint layout, admission, modal stacking, reserved-key policy, result mapping, focus restoration, and renderer lifecycle. `InputDialog`/`ConfirmDialog` report active Escape through `onCancel`; the host chooses whether to dismiss and what result that means. [#308](https://github.com/sonwjnn/wincode/issues/308), opened for the audit gap, is implemented and covered by renderer tests in this branch. |
| Lists, pickers, and settings | Public `SearchablePicker` serves Coding-Agent's Theme dialog and the independent time-zone picker. `SettingsList` serves Coding-Agent's Thinking Level dialog and the independent clock-format settings app. Both are also documented and renderer-tested. | Settings schema, persistence, preview/rollback, selection outcomes, and feature data remain in Coding-Agent. Eight other dialogs retain `SearchListDialogWrapper` for host-specific rows, margins, footers, and key policy, but now delegate query/filter state, selection, arrow navigation, and scroll-to-highlight to public `useSearchableList`. Their feature data and `fuzzyMatch` predicates remain app-owned. This completes #307's consolidation scope; replacing these host-specific views with generic rendered picker/settings compositions is not needed to share their mechanics. |
| Input, editor, and autocomplete | `MultilineEditor` and `EditorAutocomplete` are used by Coding-Agent's `ChatTextArea` and the independent notes app (`packages/tui/examples/independent-app.tsx`). | Coding-Agent supplies slash-command and file-mention candidates, replacement edits, prompt history, and key policy. The independent app supplies its own candidates and edits. `PluginEditorDialog` still uses a raw OpenTUI `textarea`; reusing the shared editor while preserving its Ctrl+Enter/host-cancel contract is tracked in [#309](https://github.com/sonwjnn/wincode/issues/309). |
| Layout and content display | `BoundedContentPanel` is used by Coding-Agent's `markdown-message-part.tsx` and the independent offline Markdown viewer (`packages/tui/examples/offline-markdown-viewer.tsx`). | The panel bounds width and preserves natural height; it is not a viewport. Coding-Agent keeps its single transcript `ScrollBox`; the independent viewer owns a separate `ScrollBox`. General OpenTUI renderables remain available through `@wincode/tui/core`, so no second scroll-container abstraction was added. |
| Theme and feedback | Coding-Agent adapts its persisted theme through `ThemeProvider`; its project-trust/plugin views use `InlineNotice`, and its operation/toast UI uses the feedback compositions. The independent app uses `ThemeProvider`, `LocalStyleProvider`, `InlineNotice`, `StatusFeedback`, and `NotificationToast`. | Theme persistence, operation state, toast visibility/dismissal, and notification policy remain with the host. Shared components render the supplied state and theme only. |

## Existing public facilities and retained host helpers

- Simple selection and rendering primitives are available through `@wincode/tui/core`: `SelectRenderable`, `ScrollBoxRenderable`, `Selection`, `TextAttributes`, `MarkdownRenderable`, and the renderer-backed JSX primitives. Plugin choice prompts and the export-scope form use the existing OpenTUI `select`; these primitives are sufficient for app-specific simple rows, borders, insets, and scroll regions. `DialogFrame` adds the shared bounded modal presentation; the other public compositions add shared interaction behavior rather than wrapping every primitive.
- `createUiHost`, `useKeyboard`, `useFocus`, `usePaste`, `useRenderer`, and `useTerminalDimensions` provide generic renderer and interaction wiring. They do not create or destroy a renderer.
- `DialogInset`, `DialogFooterHint`, and `SelectableDialogItem` remain in Coding-Agent because they encode its dialog margins, shortcut vocabulary, and row decoration. `SearchListDialogWrapper` is a host adapter that imports `useSearchableList` from `@wincode/tui`; it owns only domain-specific filtering predicates, layout, and key policy. The raw Plugin editor field is tracked by #309.
- Broader Plugin contribution surfaces in ADR-0058/the design plan—such as custom editor ownership, keyed status/widgets, header/footer slots, tool/message/entry renderers, Markdown transforms, and RPC UI protocol—are not requirements of #298's five-family composition slice and are not represented as delivered here. #298 explicitly excludes porting the complete research reference as an API checklist.

### Remaining search-list callers

The eight consumers of the private wrapper are:

- `packages/coding-agent/tui/commands/project-trust-dialog.tsx`
- `packages/coding-agent/modules/providers/ui/provider-sdk-connect-dialog.tsx`
- `packages/coding-agent/modules/sessions/ui/dialogs/sessions-dialog.tsx`
- `packages/coding-agent/modules/providers/ui/provider-models-dialog.tsx`
- `packages/coding-agent/modules/sessions/ui/dialogs/session-history-tree-dialog.tsx`
- `packages/coding-agent/modules/plugins/ui/plugin-status-panel-dialog.tsx`
- `packages/coding-agent/modules/prompt-settings/ui/agents-dialog.tsx`
- `packages/coding-agent/modules/settings/settings-dialog.tsx`

These retain feature-specific screens and policies: Project Trust owns permission choices; provider dialogs own connection and model-catalog state; Session dialogs own navigation, pagination, and history actions; Plugin status owns capability gates; agent/settings dialogs own their schemas and persistence. All eight views share the public `useSearchableList` mechanics through the adapter; their host-specific rendered rows and policies do not require replacing them with a generic picker.

## Package and lifecycle boundaries

- `packages/tui/src/index.ts` exports the shared compositions and generic renderer hooks. `packages/tui/src` has no Coding-Agent imports; `packages/tui/package.json` depends on OpenTUI and `@wincode/utils`, with React as a peer.
- Coding-Agent routes rendering through `packages/coding-agent/tui/renderer-session.tsx`: it creates the renderer, passes it to `createUiHost`, and owns unmount/disposal. Independent examples accept a caller-owned renderer, create a UI host, and leave renderer teardown to that caller.
- No consumer needs a direct `@opentui/*` import; `packages/coding-agent/test/tui-import-boundary.test.ts` enforces the `@wincode/tui/core` facade.
- The shared layer does not own Session/Agent behavior, settings persistence, permission decisions, operation execution, notification timing, or routing. JSON, Print, and RPC remain application modes rather than terminal-renderer compositions.

## Evidence in the test suite

The TUI package has renderer-level contracts for bounded dialogs, active Escape cancellation through host callbacks (including inactive-layer non-leakage), and the independent prompt flow; picker/settings selection (including Enter after mounted items shrink and a selected row remaining visible after an 18-to-8-row resize); editor completion; bounded Markdown content and its independent viewer; themes; and feedback. Coding-Agent's Theme picker renderer test also shrinks an open dialog to eight rows and verifies the query, active result, and keyboard guidance remain visible; Session History Tree tests verify paging and navigation in its host-owned scrollable area inside `DialogFrame`. Coding-Agent tests cover the corresponding host flows, including settings/theme behavior, plugin UI, transcript Markdown, notices, and autocomplete overlay behavior. The slash/file-mention E2E regression test is `packages/coding-agent/test/sessions/command-popover.e2e.test.tsx`.

## Verification record

- `bun fix`: checked 983 files with no fixes. `bun check` passed; `bun check-types` passed for all seven workspaces.
- `bun run test`: 2,798 tests reported by the runners; the Default portfolio executed all 293 discovered test files and exited with 0 failures.
- `bun run test:e2e`: all 9 E2E test files completed with 0 failures.
- Renderer checks: 34 TUI tests passed across 14 files; independent-consumer smoke tests passed 11/11 across 5 files; terminal-free and renderer-boundary checks passed 74/74 across 5 Coding-Agent test files.
- `bun run packages/coding-agent/bin/wincode.ts --help` exited successfully without starting a terminal renderer and listed interactive, print, JSON, and RPC modes.

Final Standards and Spec reviews against `master` approved the implementation: no documented-standard breaches and no spec gaps. The Standards reviewer noted minor optional duplication in the dialogs' compact-layout and theme-color setup.
