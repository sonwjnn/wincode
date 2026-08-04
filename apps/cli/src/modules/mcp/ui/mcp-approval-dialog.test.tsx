import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useEffect } from "react";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	createMcpApprovalController,
	type McpApprovalController,
} from "../context/approval-controller";
import type { McpApprovalRequest } from "../registry";
import {
	formatApprovalDescription,
	MAX_DESCRIPTION_CHARS,
	McpApprovalDialog,
} from "./mcp-approval-dialog";

const makeRequest = (
	overrides: Partial<McpApprovalRequest> = {}
): McpApprovalRequest => ({
	description: "Echo text back",
	input: { text: "hello" },
	originalToolName: "echo",
	serverName: "demo",
	...overrides,
});

type ApprovalDialogSetup = {
	controller: McpApprovalController;
	setup: Awaited<ReturnType<typeof testRender>>;
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

const renderApprovalDialog = async (
	request: McpApprovalRequest,
	controller: McpApprovalController
): Promise<ApprovalDialogSetup> => {
	// The approval content's default dialog layer id is "dialog"; push that layer
	// so the keyboard handlers treat this dialog as the top layer.
	function Harness() {
		const { push } = useKeyboardLayer();
		useEffect(() => {
			push("dialog");
		}, [push]);
		return <McpApprovalDialog controller={controller} request={request} />;
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

test("enter settles against the latest selection after rapid navigation", async () => {
	const controller = createMcpApprovalController();
	const approval = controller.request(makeRequest());
	const { setup } = await renderApprovalDialog(makeRequest(), controller);

	expect(setup.captureCharFrame()).toContain("> Allow once");

	// Flip Allow -> Deny -> Allow -> Deny with no render commit between key
	// presses; enter must reflect the final selection, not the first render's.
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	await expect(approval).resolves.toBe(false);
	setup.renderer.destroy();
});

test("formatApprovalDescription bounds runaway descriptions", () => {
	const tail = "TAIL";
	const oversized = `${"x".repeat(4096)}${tail}`;
	const formatted = formatApprovalDescription(oversized);
	expect(formatted).not.toContain(tail);
	expect(formatted.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 1);
	expect(formatted.endsWith("…")).toBe(true);
});

test("formatApprovalDescription leaves short descriptions intact", () => {
	const short = "Echo text back";
	expect(formatApprovalDescription(short)).toBe(short);
});

test("dialog renders bounded description for oversized input", async () => {
	const controller = createMcpApprovalController();
	const tail = "RUNAWAYDESCRIPTION";
	const { setup } = await renderApprovalDialog(
		makeRequest({ description: `${"y".repeat(4096)}${tail}` }),
		controller
	);
	const frame = setup.captureCharFrame();
	expect(frame).toContain("description");
	expect(frame).not.toContain(tail);
	setup.renderer.destroy();
});
