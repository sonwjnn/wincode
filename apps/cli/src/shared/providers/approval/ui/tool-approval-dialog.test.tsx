import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useEffect } from "react";
import {
	type ApprovalController,
	createApprovalController,
} from "@/shared/providers/approval/approval-controller";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { formatApprovalDescription, MAX_DESCRIPTION_CHARS } from "../format";
import {
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

type ApprovalDialogSetup = {
	controller: ApprovalController<ToolApprovalRequest>;
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
	controller: ApprovalController<ToolApprovalRequest>
): Promise<ApprovalDialogSetup> => {
	// Open the dialog through the provider so escape can close it through the
	// dialog stack, exactly like the app opens it via useToolPermission.
	function Harness() {
		const { push } = useKeyboardLayer();
		const { open } = useDialog();
		useEffect(() => {
			push("dialog");
			open({
				children: (
					<ToolApprovalDialog controller={controller} request={request} />
				),
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
	return { controller, setup };
};

test("renders tool identity, resource, description, and input", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const approval = controller.request(makeRequest());
	const { setup } = await renderApprovalDialog(makeRequest(), controller);
	const frame = setup.captureCharFrame();

	expect(frame).toContain("tool");
	expect(frame).toContain("read");
	expect(frame).toContain("resource");
	expect(frame).toContain(".env");
	expect(frame).toContain("description");
	expect(frame).toContain("Read a UTF-8 text file inside the workspace.");
	expect(frame).toContain("input");
	expect(frame).toContain("> Allow once");
	expect(frame).toContain("Deny");
	setup.renderer.destroy();
	await expect(approval).resolves.toBe(false);
});

test("allow once settles the request with true", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const approval = controller.request(makeRequest());
	const { setup } = await renderApprovalDialog(makeRequest(), controller);

	setup.mockInput.pressEnter();
	await flushUi(setup);

	await expect(approval).resolves.toBe(true);
	setup.renderer.destroy();
});

test("deny settles the request with false", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const approval = controller.request(makeRequest());
	const { setup } = await renderApprovalDialog(makeRequest(), controller);

	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	await expect(approval).resolves.toBe(false);
	setup.renderer.destroy();
});

test("escape closes the dialog and cancels the request", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const approval = controller.request(makeRequest());
	const { setup } = await renderApprovalDialog(makeRequest(), controller);

	setup.mockInput.pressEscape();
	// Escape closes the dialog; the unmount cleanup settles the pending request.
	// Allow the unmount and the follow-up store commit before asserting.
	await flushUi(setup);
	await flushUi(setup);

	await expect(approval).resolves.toBe(false);
	setup.renderer.destroy();
});

test("bounds runaway descriptions in the dialog", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const tail = "RUNAWAYDESCRIPTION";
	const { setup } = await renderApprovalDialog(
		makeRequest({ description: `${"y".repeat(4096)}${tail}` }),
		controller
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
	controller.cancel();
});

test("bounds runaway inputs in the dialog", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const tail = "RUNAWAYINPUT";
	const { setup } = await renderApprovalDialog(
		makeRequest({
			input: { path: `${"x".repeat(8192)}${tail}` },
		}),
		controller
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
	controller.cancel();
});

test("bounds runaway identity and resource values in the dialog", async () => {
	const controller = createApprovalController<ToolApprovalRequest>();
	const tail = "RUNAWAYIDENTITY";
	const { setup } = await renderApprovalDialog(
		makeRequest({
			identity: [
				{ label: "tool", value: `${"t".repeat(1024)}${tail}` },
				{ label: "resource", value: `${"r".repeat(1024)}${tail}` },
			],
		}),
		controller
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
	controller.cancel();
});

test("formatApprovalDescription bounds oversized descriptions", () => {
	const tail = "TAIL";
	const formatted = formatApprovalDescription(`${"x".repeat(4096)}${tail}`);
	expect(formatted).not.toContain(tail);
	expect(formatted.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 1);
	expect(formatted.endsWith("…")).toBe(true);
});
