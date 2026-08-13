import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useEffect } from "react";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	formatApprovalDescription,
	formatApprovalInput,
	MAX_DESCRIPTION_CHARS,
} from "../format";
import {
	type ToolApprovalActions,
	ToolApprovalDialog,
	type ToolApprovalRequest,
} from "./tool-approval-dialog";

const makeRequest = (
	overrides: Partial<ToolApprovalRequest> = {}
): ToolApprovalRequest => ({
	description: "Read a UTF-8 text file inside the workspace.",
	identity: [
		{ label: "tool", value: "read" },
		{ label: "resource", value: ".env" },
	],
	input: { path: ".env" },
	...overrides,
});

const makeActions = (): ToolApprovalActions => ({
	allow: mock(() => undefined),
	reject: mock(() => undefined),
	cancel: mock(() => undefined),
});

type ApprovalDialogSetup = {
	actions: ToolApprovalActions;
	setup: Awaited<ReturnType<typeof testRender>>;
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

const renderApprovalDialog = async (
	request: ToolApprovalRequest,
	actions: ToolApprovalActions
): Promise<ApprovalDialogSetup> => {
	// Open the dialog through the provider so escape can close it through the
	// dialog stack, exactly like the app opens it via useToolPermission.
	function Harness() {
		const { push } = useKeyboardLayer();
		const { open } = useDialog();
		useEffect(() => {
			push("dialog");
			open({
				children: <ToolApprovalDialog actions={actions} request={request} />,
				title: "Tool approval",
				width: 100,
			});
		}, [open, push]);
		return <text>base</text>;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<DialogProvider>
					<Harness />
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return { actions, setup };
};

test("renders identity, description, input, and every approval option", async () => {
	const { setup } = await renderApprovalDialog(makeRequest(), makeActions());
	const frame = setup.captureCharFrame();

	expect(frame).toContain("tool");
	expect(frame).toContain("read");
	expect(frame).toContain("resource");
	expect(frame).toContain(".env");
	expect(frame).toContain("description");
	expect(frame).toContain("Read a UTF-8 text file inside the workspace.");
	expect(frame).toContain("input");
	expect(frame).toContain("rejection feedback");
	expect(frame).toContain("> Allow once");
	expect(frame).toContain("Always allow");
	expect(frame).toContain("Reject");
	setup.renderer.destroy();
});

test("hides the always option and warns under the safety ceiling", async () => {
	const { setup } = await renderApprovalDialog(
		makeRequest({ safety: true }),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	expect(frame).toContain("Safety ceiling");
	expect(frame).toContain("Allow once");
	expect(frame).toContain("Reject");
	// A safety ask must never mint a grant, so "always" is absent.
	expect(frame).not.toContain("Always allow");
	setup.renderer.destroy();
});

test("allow once settles with allow(false)", async () => {
	const { actions, setup } = await renderApprovalDialog(
		makeRequest(),
		makeActions()
	);

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(false);
	expect(actions.reject).not.toHaveBeenCalled();
	setup.renderer.destroy();
});

test("selecting always settles with allow(true)", async () => {
	const { actions, setup } = await renderApprovalDialog(
		makeRequest(),
		makeActions()
	);

	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(true);
	setup.renderer.destroy();
});

test("rapid keyboard selection resolves against the latest option", async () => {
	const { actions, setup } = await renderApprovalDialog(
		makeRequest(),
		makeActions()
	);

	// Several selection keys land before a render commits; enter must resolve the
	// final selection (Allow once -> Always -> Reject -> back to Allow once).
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(false);
	setup.renderer.destroy();
});

test("reject settles with the typed feedback", async () => {
	const { actions, setup } = await renderApprovalDialog(
		makeRequest(),
		makeActions()
	);

	await setup.mockInput.typeText("use the config loader");
	await flushUi(setup);
	// Move to the Reject option (Allow once -> Always -> Reject) and confirm.
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.reject).toHaveBeenCalledTimes(1);
	const feedback = (actions.reject as ReturnType<typeof mock>).mock
		.calls[0]?.[0];
	expect(feedback).toContain("use the config loader");
	expect(actions.allow).not.toHaveBeenCalled();
	setup.renderer.destroy();
});

test("escape closes the dialog and cancels the request", async () => {
	const { actions, setup } = await renderApprovalDialog(
		makeRequest(),
		makeActions()
	);

	setup.mockInput.pressEscape();
	// Escape closes the dialog; the unmount cleanup cancels the pending request.
	await flushUi(setup);
	await flushUi(setup);

	expect(actions.cancel).toHaveBeenCalled();
	expect(actions.allow).not.toHaveBeenCalled();
	setup.renderer.destroy();
});

test("bounds runaway descriptions in the dialog", async () => {
	const tail = "RUNAWAYDESCRIPTION";
	const { setup } = await renderApprovalDialog(
		makeRequest({ description: `${"y".repeat(4096)}${tail}` }),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
});

test("bounds runaway inputs in the dialog", async () => {
	const tail = "RUNAWAYINPUT";
	const { setup } = await renderApprovalDialog(
		makeRequest({ input: { path: `${"x".repeat(8192)}${tail}` } }),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
});

test("bounds runaway identity and resource values in the dialog", async () => {
	const tail = "RUNAWAYIDENTITY";
	const { setup } = await renderApprovalDialog(
		makeRequest({
			identity: [
				{ label: "tool", value: `${"t".repeat(1024)}${tail}` },
				{ label: "resource", value: `${"r".repeat(1024)}${tail}` },
			],
		}),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
});

test("formatApprovalDescription bounds oversized descriptions", () => {
	const tail = "TAIL";
	const formatted = formatApprovalDescription(`${"x".repeat(4096)}${tail}`);
	expect(formatted).not.toContain(tail);
	expect(formatted.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 1);
	expect(formatted.endsWith("…")).toBe(true);
});

test("formatApprovalInput bounds traversal and redacts secrets", () => {
	const input: Record<string, unknown> = {
		auth: "hidden-auth",
		headers: "Authorization: Bearer hidden-token",
		oversized: `${"x".repeat(4096)}TAIL`,
	};
	input.self = input;
	const formatted = formatApprovalInput(input);

	expect(formatted).toContain("[redacted]");
	expect(formatted).toContain("[circular]");
	expect(formatted).not.toContain("hidden-auth");
	expect(formatted).not.toContain("hidden-token");
	expect(formatted).not.toContain("TAIL");
});
