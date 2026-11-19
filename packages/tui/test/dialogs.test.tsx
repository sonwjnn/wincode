import { expect, test } from "bun:test";
import {
	ConfirmDialog,
	createUiHost,
	InputDialog,
	ThemeProvider,
	type TuiTheme,
	useKeyboard,
} from "@wincode/tui";
import { createTestRenderer } from "@wincode/tui/testing";
import { act, type ReactNode, useState } from "react";

const theme: TuiTheme = {
	colors: {
		backgroundElement: "#161b22",
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		text: "#ffffff",
		textMuted: "#8b949e",
		warning: "#d29922",
	},
};

function PromptHarness({
	onResult,
}: Readonly<{ onResult: (result: string | undefined) => void }>) {
	const [dialog, setDialog] = useState<"input" | "confirm" | null>("input");
	const [answer, setAnswer] = useState("");
	const [composer, setComposer] = useState("draft");

	useKeyboard((key) => {
		if (key.name !== "escape" || dialog === null) {
			return;
		}
		key.preventDefault();
		setDialog(null);
		onResult(undefined);
	});

	let dialogContent: ReactNode;
	switch (dialog) {
		case "input":
			dialogContent = (
				<InputDialog
					active
					onSubmit={(value) => {
						setAnswer(value);
						setDialog("confirm");
					}}
					prompt="Workspace name"
				/>
			);
			break;
		case "confirm":
			dialogContent = (
				<ConfirmDialog
					active
					message={`Use ${answer}?`}
					onConfirm={(confirmed) => {
						setDialog(null);
						onResult(confirmed ? `confirmed:${answer}` : undefined);
					}}
				/>
			);
			break;
		default:
			dialogContent = <text>{`Result: ${answer || "cancelled"}`}</text>;
	}

	return (
		<box flexDirection="column">
			<text>{`Composer: ${composer}`}</text>
			<input focused={dialog === null} onInput={setComposer} value={composer} />
			{dialogContent}
		</box>
	);
}

test("input and confirmation dialogs return entered values through terminal keys", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const host = createUiHost(setup.renderer);
	let result: string | undefined;
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<PromptHarness onResult={(value) => (result = value)} />
				</ThemeProvider>
			)
		);
		await setup.flush();
		await act(() => setup.mockInput.typeText("team-alpha"));
		await setup.flush();
		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Use team-alpha?");
		await act(() => setup.mockInput.pressArrow("up"));
		await setup.flush();
		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(result).toBe("confirmed:team-alpha");

		await act(() => setup.mockInput.typeText(" restored"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Composer: draft restored");
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("Escape cancels the active input without leaking into the composer", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 10,
		kittyKeyboard: true,
		width: 40,
	});
	const host = createUiHost(setup.renderer);
	let result: string | undefined = "pending";
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<PromptHarness onResult={(value) => (result = value)} />
				</ThemeProvider>
			)
		);
		await setup.flush();
		await act(() => setup.mockInput.typeText("private"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Composer: draft");
		await act(() => setup.mockInput.pressEscape());
		await setup.flush();
		expect(result).toBeUndefined();
		expect(setup.captureCharFrame()).toContain("Result: cancelled");
		await act(() => setup.mockInput.typeText(" restored"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Composer: draft restored");
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
