/** @jsxImportSource @wincode/tui */

import {
	createUiHost,
	EditorAutocomplete,
	type EditorAutocompleteItem,
	InlineNotice,
	LocalStyleProvider,
	MultilineEditor,
	NotificationToast,
	StatusFeedback,
	ThemeProvider,
	type TuiTheme,
	type UiHost,
	useKeyboard,
} from "@wincode/tui";
import {
	type CliRenderer,
	createCliRenderer,
	type TextareaRenderable,
} from "@wincode/tui/core";
import { useRef, useState } from "react";

type NoteCompletion = EditorAutocompleteItem &
	Readonly<{ replacement: string }>;

const NOTE_COMPLETIONS: readonly NoteCompletion[] = [
	{
		description: "Capture decisions and owners",
		id: "meeting-recap",
		label: "Write a meeting recap",
		replacement: "Decisions and owners from the meeting",
	},
	{
		description: "Record the next milestone",
		id: "launch-plan",
		label: "Update the launch plan",
		replacement: "Confirm the launch plan",
	},
];

const APP_THEME: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

function IndependentApp({ onStop }: { onStop: () => void }) {
	const [note, setNote] = useState("");
	const [completionOpen, setCompletionOpen] = useState(false);
	const [selectedCompletion, setSelectedCompletion] = useState(0);
	const editorRef = useRef<TextareaRenderable>(null);
	const savedNote = `Saved note: ${note}`;
	const [showNotification, setShowNotification] = useState(true);
	useKeyboard((key) => {
		if (completionOpen) {
			return;
		}
		if (key.name === "space" && key.ctrl) {
			key.preventDefault();
			key.stopPropagation();
			setSelectedCompletion(0);
			setCompletionOpen(true);
			return;
		}
		if (key.name === "escape") {
			onStop();
		} else if (key.name === "d") {
			setShowNotification(false);
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<text>Independent OpenTUI + React app</text>
			<LocalStyleProvider colors={{ info: "#7ee787" }}>
				<InlineNotice>Shared notice from @wincode/tui</InlineNotice>
			</LocalStyleProvider>
			<box flexDirection="column" overflow="visible">
				<EditorAutocomplete
					active={completionOpen}
					emptyMessage="No note suggestions"
					items={NOTE_COMPLETIONS}
					onApply={(item) => {
						editorRef.current?.replaceText(item.replacement);
						setNote(item.replacement);
						setCompletionOpen(false);
					}}
					onCancel={() => {
						setCompletionOpen(false);
						setSelectedCompletion(0);
					}}
					onSelectedIndexChange={setSelectedCompletion}
					open={completionOpen}
					selectedIndex={selectedCompletion}
				/>
				<MultilineEditor
					focused
					height={4}
					onChange={setNote}
					placeholder="Write a note..."
					ref={editorRef}
				/>
			</box>
			<text height={savedNote.split("\n").length}>{savedNote}</text>
			<box flexDirection="column" gap={1}>
				<LocalStyleProvider colors={{ error: "#ff78c6", info: "#7ee787" }}>
					<StatusFeedback
						message="Loading local configuration"
						status="loading"
					/>
					<StatusFeedback
						message="Indexing files"
						progress={{ current: 2, total: 4 }}
						status="progress"
					/>
					<StatusFeedback message="Workspace ready" status="success" />
					<StatusFeedback message="Local operation failed" status="error" />
					{showNotification ? (
						<NotificationToast
							message="Offline example notification"
							variant="error"
						/>
					) : null}
				</LocalStyleProvider>
			</box>
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
