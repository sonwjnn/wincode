/** @jsxImportSource @wincode/tui */

import {
	ConfirmDialog,
	createUiHost,
	DialogFrame,
	InputDialog,
	ThemeProvider,
	type TuiTheme,
	type UiHost,
	useKeyboard,
	useTerminalDimensions,
	useTheme,
} from "@wincode/tui";
import { type CliRenderer, createCliRenderer } from "@wincode/tui/core";
import { useRef, useState } from "react";

const DEFAULT_BACKGROUND_COLOR = "#161b22";

const PROMPT_THEME: TuiTheme = {
	colors: {
		backgroundElement: DEFAULT_BACKGROUND_COLOR,
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		text: "#ffffff",
		textMuted: "#8b949e",
		warning: "#d29922",
	},
};

type PromptFlowProps = Readonly<{
	onComplete: (value: string | undefined) => void;
	onExit: () => void;
}>;

function PromptFlow({ onComplete, onExit }: PromptFlowProps) {
	const [phase, setPhase] = useState<"input" | "confirm" | "done">("input");
	const [workspaceName, setWorkspaceName] = useState("");
	const [composerText, setComposerText] = useState("");
	const [resultLabel, setResultLabel] = useState("Prompt is open.");
	const completedRef = useRef(false);
	const { width, height } = useTerminalDimensions();
	const { colors } = useTheme();
	const backgroundColor =
		typeof colors.backgroundElement === "string"
			? colors.backgroundElement
			: DEFAULT_BACKGROUND_COLOR;
	const textColor = typeof colors.text === "string" ? colors.text : undefined;

	const finish = (value: string | undefined) => {
		if (completedRef.current) {
			return;
		}
		completedRef.current = true;
		setPhase("done");
		setResultLabel(
			value === undefined ? "Prompt cancelled." : `Confirmed: ${value}`
		);
		onComplete(value);
	};

	useKeyboard((key) => {
		if (key.name !== "escape" || phase !== "done") {
			return;
		}
		key.preventDefault();
		onExit();
	});

	return (
		<box height={height} width={width}>
			<box flexDirection="column" height="100%" padding={1} width="100%">
				<text>Independent prompt flow</text>
				<text>Workspace composer</text>
				<input
					focused={phase === "done"}
					onInput={setComposerText}
					placeholder="Type workspace notes"
					value={composerText}
				/>
				<text>{`Composer: ${composerText}`}</text>
				<text>{resultLabel}</text>
			</box>
			{phase === "done" ? null : (
				<DialogFrame
					backgroundColor={backgroundColor}
					border
					padding={1}
					zIndex={100}
				>
					<box flexDirection="column" gap={1}>
						<text fg={textColor}>Workspace setup</text>
						{phase === "input" ? (
							<InputDialog
								active
								onCancel={() => finish(undefined)}
								onSubmit={(value) => {
									setWorkspaceName(value);
									setPhase("confirm");
								}}
								prompt="What should we call this workspace?"
							/>
						) : (
							<ConfirmDialog
								active
								message={`Use ${workspaceName || "this workspace"}?`}
								onCancel={() => finish(undefined)}
								onConfirm={(confirmed) =>
									finish(confirmed ? workspaceName : undefined)
								}
							/>
						)}
					</box>
				</DialogFrame>
			)}
		</box>
	);
}

/** Shows the shared prompts inside a caller-owned renderer and React root. */
export function startIndependentPromptFlow(
	renderer: CliRenderer,
	onComplete: (value: string | undefined) => void,
	onExit: () => void = () => undefined
): UiHost {
	const host = createUiHost(renderer);
	host.render(
		<ThemeProvider theme={PROMPT_THEME}>
			<PromptFlow onComplete={onComplete} onExit={onExit} />
		</ThemeProvider>
	);
	return host;
}

async function runPromptFlow(): Promise<void> {
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	let host: UiHost | undefined;
	const stop = (): void => {
		if (host === undefined) {
			return;
		}
		host.unmount();
		renderer.destroy();
	};
	host = startIndependentPromptFlow(renderer, () => undefined, stop);
	await renderer.closed;
}

if (import.meta.main) {
	await runPromptFlow();
}
