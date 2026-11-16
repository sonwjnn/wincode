# `@wincode/tui`

Reusable OpenTUI + React UI facilities for Coding-Agent, Plugins, and independent terminal applications. This package is a UI library, not the Coding-Agent application or an alternate renderer framework.

## Public exports

| Export | Import surface | Purpose |
| --- | --- | --- |
| `createUiHost`, `UiHost` | `@wincode/tui` | Create a React root for a caller-owned OpenTUI renderer; render React nodes and unmount the root. |
| `ThemeProvider`, `useTheme`, `TuiTheme`, `TuiThemeColors`, `TuiThemeColor` | `@wincode/tui` | Provide a reactive theme and read its colors from React components. |
| `LocalStyleProvider`, `LocalStyleColors` | `@wincode/tui` | Override color tokens within one React subtree without changing the application theme. |
| `InlineNotice`, `InlineNoticeProps`, `InlineNoticeVariant` | `@wincode/tui` | Render a wrapped notice using the active theme's `info`, `success`, `warning`, or `error` token. |

`@opentui/core`, `@opentui/react`, and React are peer requirements. The consuming application supplies and owns its renderer lifecycle.

## React usage

```tsx
import { createCliRenderer } from "@opentui/core";
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
