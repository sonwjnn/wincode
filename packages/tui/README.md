# `@wincode/tui`

Reusable OpenTUI + React UI facilities for Coding-Agent, Plugins, and independent terminal applications. This package is a UI library, not the Coding-Agent application or an alternate renderer framework.

## Public exports

The public API is grouped by import path. OpenTUI-backed exports are re-exported through `@wincode/tui`; Coding-Agent and Plugins should not import those names directly from OpenTUI.

- `@wincode/tui`
  - `createUiHost`, `UiHost` — create a React root for a caller-owned renderer and manage its render/unmount lifecycle.
  - `BoundedContentPanel`, `BoundedContentPanelProps` — size content to its host width and preserve its natural height; the host owns any scroll viewport.
  - `DialogFrame`, `DialogFramePadding`, `DialogFrameProps` — center and bound host-provided dialog content without owning modal policy.
  - `InputDialog`, `InputDialogProps` — render themed text entry and report submit/cancel events to the caller.
  - `ConfirmDialog`, `ConfirmDialogProps` — render themed Yes/No confirmation and report confirm/cancel events to the caller.
  - `InlineNotice`, `InlineNoticeProps`, `InlineNoticeVariant` — render a wrapped notice using the active theme.
  - `EditorAutocomplete`, `EditorAutocompleteItem`, `EditorAutocompleteProps` — reusable editor suggestion presentation, keyboard navigation, apply, and dismissal; the host supplies candidates and owns edits.
  - `MultilineEditor`, `MultilineEditorProps` — reusable multiline text editing with paste and selection support; `onChange` reports the full edited text to the host.
  - `SearchablePicker`, `SearchablePickerProps`, `SearchablePickerItemState` — render a focused fuzzy-search input and selectable, scrollable results.
  - `useSearchableList`, `SearchableListOptions` — share query, filtering, selection, keyboard navigation, and scroll-to-highlight mechanics when the host needs custom list layout.
  - `SettingsList`, `SettingsListProps`, `SettingsListOption` — present app-provided setting choices, mark the current value, and report only explicitly selected values.
  - `StatusFeedback`, `StatusFeedbackProps`, `StatusFeedbackProgress` — present loading, determinate progress, success, or error without owning operation policy.
  - `NotificationToast`, `NotificationToastProps`, `NotificationVariant` — present a themed notification; the caller owns visibility and dismissal.
  - `createPortal`, `useAppContext`, `useFocus`, `useKeyboard`, `usePaste`, `useRenderer`, `useTerminalDimensions` — access host renderer context, focus, keyboard, paste, and terminal dimensions.
  - `LocalStyleColors`, `LocalStyleProvider`, `ThemeProvider`, `TuiTheme`, `TuiThemeColors`, `TuiThemeColor`, `useTheme` — provide a reactive theme and subtree-local color overrides.
- `@wincode/tui/bounded-content-panel`
  - `BoundedContentPanel`, `BoundedContentPanelProps` — import the bounded content sizing composition without using the package-root barrel.
- `@wincode/tui/core`
  - Renderer: `CapturedFrame`, `CliRenderEvents`, `CliRenderer`, `createCliRenderer`, `NativeResourceOwner`, `Renderable`, `RendererClipboardBoundary`.
  - Renderables and selection: `BoxRenderable`, `InputRenderable`, `MarkdownRenderable`, `MouseButton`, `ScrollBoxRenderable`, `SelectRenderable`, `Selection`, `SelectionBehavior`, `TextareaRenderable`.
  - Clipboard: `ClipboardReadOptions`, `ClipboardReadResult`, `ClipboardService`, `ClipboardWriteOptions`, `ClipboardWriteResult`, `HostClipboardService`, `createClipboard`, `createHostClipboard`, `createRendererClipboardAdapter`.
  - Events and text: `Extmark`, `KeyEvent`, `MouseEvent`, `PasteEvent`, `RGBA`, `SimpleHighlight`, `StyleDefinitionInput`, `SyntaxStyle`, `TextAttributes`, `TextareaOptions`.
  - Utilities: `decodePasteBytes`, `getTreeSitterClient`, `pathToFiletype`, `TreeSitterClient`.
- `@wincode/tui/testing`: `createTestRenderer`, `MockTreeSitterClient`, `MouseButtons`, `TestRecorder`, `TestRendererOptions`, `TestRendererSetup`, `testRender` — render and exercise terminal UI in tests.
- `@wincode/tui/jsx-runtime`: `Fragment`, `jsx`, `jsxs`, and the `JSX` type namespace.
- `@wincode/tui/jsx-dev-runtime`: `Fragment`, `jsxDEV`, and the `JSX` type namespace.

`@wincode/tui` owns the OpenTUI dependencies. Consumers share the host's React peer and set `compilerOptions.jsxImportSource` to `@wincode/tui`. Coding-Agent's project-trust UI, the reply-editor Plugin, and the independent example render the same `InlineNotice` component. Coding-Agent's Interactive Mode composer and the independent notes app use the same `EditorAutocomplete` and `MultilineEditor` exports. Coding-Agent and the independent example also use the same public feedback compositions. Plugins use the host renderer and React root; independent applications own their own renderer lifecycle.

## React usage

```tsx
import { createCliRenderer } from "@wincode/tui/core";
import {
	createUiHost,
	InlineNotice,
	LocalStyleProvider,
	MultilineEditor,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import { useState } from "react";

const theme: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

function Notes() {
	const [note, setNote] = useState("");
	return (
		<box flexDirection="column" gap={1}>
			<InlineNotice>Ready</InlineNotice>
			<MultilineEditor
				focused
				height={4}
				onChange={setNote}
				placeholder="Write a note..."
			/>
			<text height={Math.max(1, note.split("\n").length)}>{`Current note: ${note}`}</text>
		</box>
	);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
const host = createUiHost(renderer);
host.render(
	<ThemeProvider theme={theme}>
		<LocalStyleProvider colors={{ info: "#7ee787" }}>
			<Notes />
		</LocalStyleProvider>
	</ThemeProvider>
);

// In the application's own shutdown handler:
host.unmount();
renderer.destroy();
```

`TuiTheme.colors` requires string tokens for `error`, `info`, `success`, and `warning`; additional colors may be grouped as string maps. `ThemeProvider` reacts when its `theme` prop changes. `LocalStyleProvider` merges overrides for its descendants only. `MultilineEditor` accepts OpenTUI React `TextareaProps` except its low-level `onContentChange` event, exposes `onChange(text)` for the full current text, and forwards a `TextareaRenderable` ref for host-specific handling. Its optional `onSubmit` is a host callback that owns the meaning of submission. `initialValue` sets the starting text; it is not a controlled `value` prop. Submission, prompt history, autocomplete sources, and editor keybinding policy remain with the host.

## Editor completion

Mount `EditorAutocomplete` beside the editor and set `open` when the host has suggestions to show. Place it before `MultilineEditor` to show suggestions above the input. It renders a bounded list, wraps Up/Down navigation, applies the selected item on Enter or mouse click, and calls `onCancel` on Escape without changing editor contents. The host controls `active` so only the top keyboard layer handles input, maps its own candidates to `{ id, label, description? }`, and performs edits in `onApply`. Pass `backgroundColor` when the list overlays existing content so unselected rows cover the text behind them. The item type is generic, so host-owned fields such as a replacement string remain available to the callback.

```tsx
<EditorAutocomplete
	active={completionOpen}
	emptyMessage="No matching notes"
	items={noteCompletions}
	onApply={(completion) => {
		editorRef.current?.replaceText(completion.replacement);
		setCompletionOpen(false);
	}}
	onCancel={() => setCompletionOpen(false)}
	onSelectedIndexChange={setSelectedIndex}
	open={completionOpen}
	selectedIndex={selectedIndex}
/>
```

The runnable independent notes app demonstrates this API with note-specific candidates and edits. Run it with `bun run packages/tui/examples/independent-app.tsx`; Ctrl+Space opens suggestions, Enter applies the selected edit, and Escape dismisses suggestions without changing the note. Escape when the list is closed unmounts the React root and destroys the app-owned renderer.

## Bounded content panel

`BoundedContentPanel` accepts `children` and sizes the content to the available width while preserving its natural height. It is not a scroll container. Place it inside the host's `scrollbox` or another viewport; this lets Coding-Agent retain its single transcript viewport and leaves keyboard, selection handling, clipboard, and link policy with the host. The panel adds no selection, copy, or link handlers.

```tsx
import { BoundedContentPanel } from "@wincode/tui";

<scrollbox height="100%" width="100%">
  <BoundedContentPanel>
    <markdown content={content} syntaxStyle={syntaxStyle} width="100%" />
  </BoundedContentPanel>
</scrollbox>
```

The runnable independent consumer is [`examples/independent-app.tsx`](./examples/independent-app.tsx). The offline Markdown viewer is [`examples/offline-markdown-viewer.tsx`](./examples/offline-markdown-viewer.tsx); run it with `bun packages/tui/examples/offline-markdown-viewer.tsx`. It owns its renderer, wraps `BoundedContentPanel` in one `scrollbox`, and exits on Escape.

## Operation feedback

`StatusFeedback` renders an operation state from caller-owned data. `status="loading"` shows an animated indicator; `status="progress"` requires `{ current, total }` and shows a bounded progress bar; `success` and `error` show themed completion markers. `NotificationToast` renders a notification variant in the terminal corner. Both components inherit the active `ThemeProvider` theme and subtree-local `LocalStyleProvider` overrides.

```tsx
<StatusFeedback message="Connecting..." status="loading" />
<StatusFeedback
	message="Retrying (2/4)"
	progress={{ current: 2, total: 4 }}
	status="progress"
/>
{notificationVisible ? (
	<NotificationToast message="Connection failed" variant="error" />
) : null}
```

These components do not start, retry, recover, time out, or dismiss operations. The host decides what to notify and controls how long a toast stays visible or which input dismisses it. The independent example uses the same components as Coding-Agent, with its own renderer lifecycle and D-key dismissal.

## Searchable picker

`SearchablePicker` focuses its search input when mounted, fuzzy-matches `getSearchText` values, and keeps the highlighted result in view while navigating. Up/down wrap through selectable results; Enter calls `onSelect`; an empty result state remains searchable so users can edit or clear the query. `onHighlight` supports reversible previews, while `isItemActive` lets the caller mark its original choice. `maxVisibleItems` bounds the result viewport; when embedding the picker, set it to the rows remaining after the host's own headings, spacing, and padding. Supply `matchesSearch` when a consumer needs domain-specific matching. The caller owns cancellation and domain state. Set `isKeyboardActive={false}` under an inactive host layer to leave the search input unfocused and disable the picker's keyboard handler.

```tsx
<SearchablePicker
	items={timeZones}
	getKey={(zone) => zone.id}
	getSearchText={(zone) => [zone.label, zone.id]}
	isItemActive={(zone) => zone.id === currentTimeZone}
	onHighlight={(zone) => preview(zone.id)}
	onSelect={(zone) => confirm(zone.id)}
	renderItem={(zone, { isActive }) => (
		<text>{`${isActive ? "● " : "  "}${zone.label}`}</text>
	)}
/>
```

The component requires `ThemeProvider` and a caller-owned OpenTUI renderer/UI host. The offline, independent time-zone app owns startup, selection/cancel behavior, and renderer teardown; run it with `bun run --cwd packages/tui example:time-zone-picker`.

When a host needs its own row layout, `useSearchableList` supplies the same list state and scroll behavior without rendering the input or rows. The caller supplies the matcher and owns rendering, result policy, and the `ScrollBox` viewport:

```tsx
const list = useSearchableList({
	items,
	filterFn: (item, query) => matches(item, query),
	isItemSelectable: (item) => item.enabled,
});

<input ref={list.inputRef} onContentChange={list.handleContentChange} />
<scrollbox height={visibleRows} ref={list.scrollRef}>
	{list.filteredItems.map((item, index) => renderRow(item, index === list.selectedIndex))}
</scrollbox>
```

Use `list.moveUp()`, `list.moveDown()`, and `list.handleEnter(onSelect)` for the shared keyboard mechanics. The hook requires a caller-owned renderer/UI host and does not own a dialog, dismissal, or result mapping.

## Settings lists

`SettingsList` presents typed options, marks the current value, and calls `onSelect` only when the user confirms an option. It reuses `SearchablePicker` navigation and filtering; the caller owns cancellation, persistence, and the setting's schema. The Coding-Agent thinking-level dialog and independent clock-format app use the same component.

```tsx
<SettingsList
  currentValue={clockFormat}
  options={[
    { id: "12-hour", label: "12-hour clock", value: "12-hour" },
    { id: "24-hour", label: "24-hour clock", value: "24-hour" },
  ]}
  onSelect={setClockFormat}
/>
```

The independent clock-format example preserves the current value on Escape; run it with `bun run --cwd packages/tui example:clock-format-settings`.

## Input and confirmation dialogs

`DialogFrame` supplies the centered, terminal-bounded shell for dialog content. It requires a `backgroundColor`, defaults to 56 columns, the full terminal height, and one cell of padding, and clamps its bounds after resize. Content beyond the frame's height is clipped: the frame is not a scroll viewport. Hosts must put long or dynamic content in an appropriate scrollable control and keep fixed actions or keyboard hints in the visible area. Set `active` only for the top layer; an inactive frame remains visible beneath it but does not draw a backdrop or route backdrop clicks. `backdropColor` and `onBackdropClick` are optional presentation/callback inputs. The frame does not manage modal admission, stacking, reserved keys, or focus restoration. `InputDialog` and `ConfirmDialog` handle Escape only while active and call the required `onCancel` callback; the host decides whether to close and maps that event to its own result.

```tsx
import { ConfirmDialog, DialogFrame, InputDialog } from "@wincode/tui";

<DialogFrame
  active={isTopLayer}
  backgroundColor={colors.backgroundElement}
  onBackdropClick={dismiss}
>
  {phase === "input" ? (
    <InputDialog
      active={isTopLayer}
      onCancel={() => finish(undefined)}
      onSubmit={(value) => finish(value)}
      prompt="Workspace name"
    />
  ) : (
    <ConfirmDialog
      active={isTopLayer}
      message={`Use ${workspaceName}?`}
      onCancel={() => finish(undefined)}
      onConfirm={(confirmed) => finish(confirmed ? workspaceName : undefined)}
    />
  )}
</DialogFrame>
```

The confirmation selection defaults to No. Escape is sent to `onCancel` only for the active component; an inactive layer leaves it available to the host. The component does not close the dialog or choose a result. The independent prompt example uses `DialogFrame` with the shared input/confirmation content and exercises cancellation, focus restoration, and narrow-terminal bounds:

```sh
bun run packages/tui/examples/prompt-flow.tsx
```

In the example, Enter advances from text entry to confirmation, Escape cancels a prompt, and a second Escape exits after the result is shown. The independent app owns its renderer teardown and imports no Coding-Agent modules.

The UI-host-only consumer remains available at [`examples/independent-app.tsx`](./examples/independent-app.tsx); press Escape to unmount the React root and destroy its renderer.

## Architectural boundary

`createUiHost` attaches a React root to the renderer passed by the caller. It does not create or destroy the renderer. An independent application owns its renderer and calls `unmount()` and `renderer.destroy()` during shutdown. Coding-Agent composes the same host and components inside Interactive Mode, while retaining its application startup, Session/Agent composition, mode routing, and terminal lifecycle. Startup trust and the running application use the same renderer session.

A UI host is not a Session Host. `@wincode/tui` imports no Coding-Agent, Session, Agent, or concrete Plugin modules. It does not own execution, persistence, permissions, or routing policy. This package exports only the facilities listed above; it does not provide the imperative `render(width)` reference API or a second renderer implementation.
