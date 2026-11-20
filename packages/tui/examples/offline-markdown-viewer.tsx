/** @jsxImportSource @wincode/tui */

import {
	BoundedContentPanel,
	createUiHost,
	ThemeProvider,
	type TuiTheme,
	type UiHost,
	useKeyboard,
	useRenderer,
} from "@wincode/tui";
import {
	type CliRenderer,
	createCliRenderer,
	getTreeSitterClient,
	SyntaxStyle,
	type TreeSitterClient,
} from "@wincode/tui/core";
import { useMemo } from "react";

const VIEWER_THEME: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

const OFFLINE_MARKDOWN = [
	"# Offline Markdown viewer",
	"",
	"This viewer uses only **@wincode/tui** and OpenTUI. It does not load Coding-Agent or make network requests.",
	"",
	"## BEGIN",
	"",
	"Resize the terminal to see this Markdown reflow. Scroll to read, or drag across rendered text to select it.",
	...Array.from(
		{ length: 24 },
		(_, index) =>
			`Offline section ${index + 1}: long content remains readable in the bounded panel.`
	),
	"",
	"## END OF DOCUMENT",
].join("\n\n");

function OfflineMarkdownViewer({
	onStop,
	treeSitterClient,
}: {
	onStop: () => void;
	treeSitterClient: TreeSitterClient;
}) {
	const renderer = useRenderer();
	const syntaxStyle = useMemo(
		() =>
			SyntaxStyle.fromStyles(
				{ default: { fg: "#c9d1d9" } },
				renderer.nativeScene
			),
		[renderer]
	);

	useKeyboard((key) => {
		if (key.name === "escape") {
			onStop();
		}
	});

	return (
		<box flexDirection="column" height="100%" width="100%">
			<text>Offline Markdown viewer (Escape to exit)</text>
			<scrollbox
				flexGrow={1}
				height="100%"
				verticalScrollbarOptions={{ visible: false }}
				width="100%"
			>
				<BoundedContentPanel>
					<markdown
						conceal
						content={OFFLINE_MARKDOWN}
						fg="#c9d1d9"
						flexShrink={0}
						internalBlockMode="top-level"
						streaming={false}
						syntaxStyle={syntaxStyle}
						treeSitterClient={treeSitterClient}
						width="100%"
					/>
				</BoundedContentPanel>
			</scrollbox>
			<text>Scroll to read; drag to select; Escape exits.</text>
		</box>
	);
}

/** Mounts the offline viewer into a caller-owned renderer and leaves teardown to that caller. */
export function startOfflineMarkdownViewer(
	renderer: CliRenderer,
	onStop: () => void,
	treeSitterClient: TreeSitterClient = getTreeSitterClient()
): UiHost {
	const host = createUiHost(renderer);
	host.render(
		<ThemeProvider theme={VIEWER_THEME}>
			<OfflineMarkdownViewer
				onStop={onStop}
				treeSitterClient={treeSitterClient}
			/>
		</ThemeProvider>
	);
	return host;
}

async function runOfflineMarkdownViewer(): Promise<void> {
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	let host: UiHost;
	const stop = (): void => {
		host.unmount();
		renderer.destroy();
	};
	host = startOfflineMarkdownViewer(renderer, stop);
}

if (import.meta.main) {
	await runOfflineMarkdownViewer();
}
