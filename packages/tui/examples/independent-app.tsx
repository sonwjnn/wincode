/** @jsxImportSource @wincode/tui */

import {
	createUiHost,
	InlineNotice,
	LocalStyleProvider,
	ThemeProvider,
	type TuiTheme,
	type UiHost,
	useKeyboard,
} from "@wincode/tui";
import { type CliRenderer, createCliRenderer } from "@wincode/tui/core";

const APP_THEME: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

function IndependentApp({ onStop }: { onStop: () => void }) {
	useKeyboard((key) => {
		if (key.name === "escape") {
			onStop();
		}
	});

	return (
		<box flexDirection="column" gap={1} padding={1}>
			<text>Independent OpenTUI + React app</text>
			<LocalStyleProvider colors={{ info: "#7ee787" }}>
				<InlineNotice>Shared notice from @wincode/tui</InlineNotice>
			</LocalStyleProvider>
			<text>Press Escape to quit.</text>
		</box>
	);
}

/** Mounts the same package surface used by Coding-Agent into a caller-owned renderer. */
export function startIndependentApp(
	renderer: CliRenderer,
	onStop: () => void
): UiHost {
	const host = createUiHost(renderer);
	host.render(
		<ThemeProvider theme={APP_THEME}>
			<IndependentApp onStop={onStop} />
		</ThemeProvider>
	);
	return host;
}

async function runIndependentApp(): Promise<void> {
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	let host: UiHost;
	const stop = (): void => {
		host.unmount();
		renderer.destroy();
	};
	host = startIndependentApp(renderer, stop);
}

if (import.meta.main) {
	await runIndependentApp();
}
