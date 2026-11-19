import { expect, test } from "bun:test";
import {
	createUiHost,
	EditorAutocomplete,
	type EditorAutocompleteItem,
	MultilineEditor,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import type { TextareaRenderable } from "@wincode/tui/core";
import { createTestRenderer } from "@wincode/tui/testing";
import { act, useRef, useState } from "react";

const theme: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

type NoteCompletion = EditorAutocompleteItem & {
	replacement: string;
};

const candidates: readonly NoteCompletion[] = [
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

function CompletionEditor() {
	const [text, setText] = useState("Keep this draft");
	const [isOpen, setIsOpen] = useState(true);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const editorRef = useRef<TextareaRenderable>(null);

	return (
		<box flexDirection="column" overflow="visible">
			<box flexDirection="column" overflow="visible">
				<EditorAutocomplete
					active={isOpen}
					emptyMessage="No note templates"
					items={candidates}
					onApply={(item) => {
						editorRef.current?.replaceText(item.replacement);
						setText(item.replacement);
						setIsOpen(false);
					}}
					onCancel={() => setIsOpen(false)}
					onSelectedIndexChange={setSelectedIndex}
					open={isOpen}
					selectedIndex={selectedIndex}
				/>
				<MultilineEditor
					focused
					height={3}
					initialValue="Keep this draft"
					ref={editorRef}
				/>
				<text>{`Current text: ${text}`}</text>
			</box>
		</box>
	);
}

const renderCompletionEditor = async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 10,
		kittyKeyboard: true,
		width: 54,
	});
	const host = createUiHost(setup.renderer);
	await act(() => {
		host.render(
			<ThemeProvider theme={theme}>
				<CompletionEditor />
			</ThemeProvider>
		);
	});
	await setup.flush();
	return { host, setup };
};

test("an editor completion applies the navigated candidate through the host edit callback", async () => {
	const { host, setup } = await renderCompletionEditor();
	try {
		expect(setup.captureCharFrame()).toContain("Write a meeting recap");
		expect(setup.captureCharFrame()).toContain("Update the launch plan");

		await act(async () => {
			setup.mockInput.pressArrow("down");
			await setup.flush();
		});
		await act(() => setup.mockInput.pressEnter());
		await act(async () => setup.flush());

		expect(setup.captureCharFrame()).toContain(
			"Current text: Confirm the launch plan"
		);
		expect(setup.captureCharFrame()).not.toContain("Write a meeting recap");
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("an editor completion can be canceled without changing the draft", async () => {
	const { host, setup } = await renderCompletionEditor();
	try {
		await act(async () => {
			setup.mockInput.pressArrow("down");
			await setup.flush();
		});
		await act(async () => {
			setup.mockInput.pressKey("\u001b[27u");
			await setup.flush();
		});
		await act(async () => {
			await setup.waitForFrame(
				(frame) => !frame.includes("Write a meeting recap")
			);
		});

		expect(setup.captureCharFrame()).toContain("Current text: Keep this draft");
		expect(setup.captureCharFrame()).not.toContain("Write a meeting recap");
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
