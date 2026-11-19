# `@wincode/tui`

Reusable OpenTUI + React UI facilities for Coding-Agent, Plugins, and independent terminal applications. This package is a UI library, not the Coding-Agent application or an alternate renderer framework.

## Public exports

The public API is grouped by import path. OpenTUI-backed exports are re-exported through `@wincode/tui`; Coding-Agent and Plugins should not import those names directly from OpenTUI.

- `@wincode/tui`
  - `createUiHost`, `UiHost` — create a React root for a caller-owned renderer and manage its render/unmount lifecycle.
  - `InlineNotice`, `InlineNoticeProps`, `InlineNoticeVariant` — render a wrapped notice using the active theme.
  - `createPortal`, `useAppContext`, `useFocus`, `useKeyboard`, `usePaste`, `useRenderer`, `useTerminalDimensions` — access host renderer context, focus, keyboard, paste, and terminal dimensions.
  - `LocalStyleColors`, `LocalStyleProvider`, `ThemeProvider`, `TuiTheme`, `TuiThemeColors`, `TuiThemeColor`, `useTheme` — provide a reactive theme and subtree-local color overrides.
- `@wincode/tui/core`
  - Renderer: `CapturedFrame`, `CliRenderEvents`, `CliRenderer`, `createCliRenderer`, `NativeResourceOwner`, `Renderable`, `RendererClipboardBoundary`.
  - Renderables and selection: `BoxRenderable`, `InputRenderable`, `MarkdownRenderable`, `MouseButton`, `ScrollBoxRenderable`, `SelectRenderable`, `Selection`, `SelectionBehavior`, `TextareaRenderable`.
  - Clipboard: `ClipboardReadOptions`, `ClipboardReadResult`, `ClipboardService`, `ClipboardWriteOptions`, `ClipboardWriteResult`, `HostClipboardService`, `createClipboard`, `createHostClipboard`, `createRendererClipboardAdapter`.
  - Events and text: `Extmark`, `KeyEvent`, `MouseEvent`, `PasteEvent`, `RGBA`, `SimpleHighlight`, `StyleDefinitionInput`, `SyntaxStyle`, `TextAttributes`, `TextareaOptions`.
  - Utilities: `decodePasteBytes`, `getTreeSitterClient`, `pathToFiletype`, `TreeSitterClient`.
- `@wincode/tui/testing`: `createTestRenderer`, `MockTreeSitterClient`, `MouseButtons`, `TestRecorder`, `TestRendererOptions`, `TestRendererSetup`, `testRender` — render and exercise terminal UI in tests.
- `@wincode/tui/jsx-runtime`: `Fragment`, `jsx`, `jsxs`, and the `JSX` type namespace.
- `@wincode/tui/jsx-dev-runtime`: `Fragment`, `jsxDEV`, and the `JSX` type namespace.

`@wincode/tui` owns the OpenTUI dependencies. Consumers share the host's React peer and set `compilerOptions.jsxImportSource` to `@wincode/tui`. Coding-Agent's project-trust UI, the reply-editor Plugin, and the independent example render the same `InlineNotice` component. Plugins use the host renderer and React root; independent applications own their own renderer lifecycle.

## React usage

```tsx
import { createCliRenderer } from "@wincode/tui/core";
import {
	createUiHost,
	InlineNotice,
	LocalStyleProvider,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";

const theme: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

const renderer = await createCliRenderer({ exitOnCtrlC: false });
const host = createUiHost(renderer);
host.render(
	<ThemeProvider theme={theme}>
		<LocalStyleProvider colors={{ info: "#7ee787" }}>
			<InlineNotice>Ready</InlineNotice>
		</LocalStyleProvider>
	</ThemeProvider>
);

// In the application's own shutdown handler:
host.unmount();
renderer.destroy();
```

`TuiTheme.colors` requires string tokens for `error`, `info`, `success`, and `warning`; additional colors may be grouped as string maps. `ThemeProvider` reacts when its `theme` prop changes. `LocalStyleProvider` merges overrides for its descendants only. The complete runnable independent consumer is [`examples/independent-app.tsx`](./examples/independent-app.tsx); press Escape to unmount the React root and destroy its renderer.

## Architectural boundary

`createUiHost` attaches a React root to the renderer passed by the caller. It does not create or destroy the renderer. An independent application owns its renderer and calls `unmount()` and `renderer.destroy()` during shutdown. Coding-Agent composes the same host and components inside Interactive Mode, while retaining its application startup, Session/Agent composition, mode routing, and terminal lifecycle. Startup trust and the running application use the same renderer session.

A UI host is not a Session Host. `@wincode/tui` imports no Coding-Agent, Session, Agent, or concrete Plugin modules. It does not own execution, persistence, permissions, or routing policy. This package exports only the facilities listed above; it does not provide the imperative `render(width)` reference API or a second renderer implementation.
