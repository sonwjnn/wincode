import { expect, mock, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { useEffect } from "react";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	ApprovalPanelsProvider,
	useApprovalPanels,
} from "../approval-panels-provider";
import {
	formatApprovalDescription,
	formatApprovalInput,
	MAX_DESCRIPTION_CHARS,
} from "../format";
import type { ToolApprovalActions, ToolApprovalRequest } from "../types";
import { PendingApprovalDock, ToolApprovalPanel } from "./tool-approval-panel";

const makeRequest = (
	overrides: Partial<ToolApprovalRequest> = {}
): ToolApprovalRequest => ({
	description: "Read a UTF-8 text file inside the workspace.",
	identity: [
		{ label: "tool", value: "read" },
		{ label: "resource", value: ".env" },
	],
	input: { path: ".env" },
	toolCallId: "call-1",
	...overrides,
});

const makeActions = (): ToolApprovalActions => ({
	abort: mock(() => undefined),
	allow: mock(() => undefined),
	reject: mock(() => undefined),
	cancel: mock(() => undefined),
});

type PanelSetup = {
	actions: ToolApprovalActions;
	setup: Awaited<ReturnType<typeof testRender>>;
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};
const hoverAction = async (
	setup: Awaited<ReturnType<typeof testRender>>,
	label: string
): Promise<void> => {
	const rows = setup.captureCharFrame().split("\n");
	const row = rows.findIndex((candidate) => candidate.includes(label));
	const column = rows[row]?.indexOf(label) ?? -1;
	expect(row).toBeGreaterThanOrEqual(0);
	expect(column).toBeGreaterThanOrEqual(0);
	await setup.mockMouse.moveTo(column, row);
	await flushUi(setup);
};

function Register({
	actions,
	request,
}: {
	actions: ToolApprovalActions;
	request: ToolApprovalRequest;
}) {
	const { add } = useApprovalPanels();
	useEffect(() => {
		add(request, actions);
	}, [add, actions, request]);
	return null;
}

const renderPanel = async (
	request: ToolApprovalRequest,
	actions: ToolApprovalActions,
	pendingCount = 1
): Promise<PanelSetup> => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register actions={actions} request={request} />
					<ToolApprovalPanel
						id={request.toolCallId ?? "call-1"}
						pendingCount={pendingCount}
					/>
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return { actions, setup };
};

test("renders the OpenCode-style dock with context and actions", async () => {
	const { setup } = await renderPanel(makeRequest(), makeActions());
	const frame = setup.captureCharFrame();

	expect(frame).toContain("Permission required");
	expect(frame).toContain(
		"tool: read · resource: .env — Read a UTF-8 text file inside the workspace."
	);
	expect(frame).toContain("Allow once");
	expect(frame).toContain("Always allow");
	expect(frame).toContain("Reject");
	expect(frame).not.toContain("Abort");
	// The dock stays inline: no modal title, no always-visible feedback field,
	// and the input stays collapsed until expanded.
	expect(frame).not.toContain("Tool approval");
	expect(frame).not.toContain("rejection feedback");
	expect(frame).not.toContain('"path"');
	setup.renderer.destroy();
});

test("hides the always option and warns under the safety ceiling", async () => {
	const { setup } = await renderPanel(
		makeRequest({ safety: true }),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	expect(frame).toContain("Safety ceiling");
	expect(frame).toContain("Allow once");
	expect(frame).toContain("Reject");
	expect(frame).not.toContain("Abort");
	// A safety ask must never mint a grant, so "always" is absent.
	expect(frame).not.toContain("Always allow");
	setup.renderer.destroy();
});

test("allow once settles with allow(false) and collapses to a dim line", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(false);
	expect(actions.reject).not.toHaveBeenCalled();
	const frame = setup.captureCharFrame();
	expect(frame).toContain("allowed once");
	expect(frame).not.toContain("Allow once");
	setup.renderer.destroy();
});

test("selecting always settles with allow(true)", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	await hoverAction(setup, "Always allow");
	setup.mockInput.pressEnter();
	await flushUi(setup);
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(true);
	expect(setup.captureCharFrame()).toContain("always allowed");
	setup.renderer.destroy();
});

test("hovering an action applies its selected background and enter target", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());
	const rows = setup.captureCharFrame().split("\n");
	const actionRow = rows.findIndex((row) => row.includes("Always allow"));
	const actionColumn = rows[actionRow]?.indexOf("Always allow") ?? -1;
	expect(actionRow).toBeGreaterThanOrEqual(0);
	expect(actionColumn).toBeGreaterThanOrEqual(0);

	await setup.mockMouse.moveTo(actionColumn, actionRow);
	await flushUi(setup);
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(true);
	setup.renderer.destroy();
});

test("rapid keyboard selection resolves against the latest option", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	// Several selection keys land before a render commits; enter must resolve the
	// final selection (Allow once -> Always -> Reject -> back to Allow once).
	await hoverAction(setup, "Reject");
	await hoverAction(setup, "Allow once");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(false);
	setup.renderer.destroy();
});

test("reject settles only the selected tool when approvals remain", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions(), 2);

	await hoverAction(setup, "Reject");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.reject).toHaveBeenCalledWith(undefined);
	expect(actions.abort).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain("rejected");
	setup.renderer.destroy();
});

test("reject aborts the turn when it is the only approval", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	expect(setup.captureCharFrame()).not.toContain("Abort");
	await hoverAction(setup, "Reject");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.abort).toHaveBeenCalledTimes(1);
	expect(actions.reject).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain("aborted");
	setup.renderer.destroy();
});

test("abort settles separately from rejecting one tool", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions(), 2);

	await hoverAction(setup, "Abort");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.abort).toHaveBeenCalledTimes(1);
	expect(actions.reject).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain("aborted");
	setup.renderer.destroy();
});

test("fullscreen dock stacks every queued approval and settles head-first", async () => {
	const firstActions = makeActions();
	const secondActions = makeActions();
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register actions={firstActions} request={makeRequest()} />
					<Register
						actions={secondActions}
						request={makeRequest({
							description: "Second queued approval.",
							toolCallId: "call-2",
						})}
					/>
					<PendingApprovalDock fullscreen />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);

	let frame = setup.captureCharFrame();
	// The active head fills the viewport; the waiting card sits below it.
	expect(frame).toContain("1 of 2");
	expect(frame).toContain("Read a UTF-8 text file inside the workspace.");
	expect(frame.match(/Permission required/gu)).toHaveLength(1);
	// Only the active head offers controls; the waiting card is read-only.
	expect(frame.match(/Allow once/gu)).toHaveLength(1);

	// Scroll the hidden-scrollbar stack to review the queued request.
	const stackScrollbox = setup.renderer.root.findDescendantById(
		"approval-stack-scrollbox"
	) as ScrollBoxRenderable | undefined;
	expect(stackScrollbox).toBeDefined();
	stackScrollbox?.scrollTo(Number.MAX_SAFE_INTEGER);
	await setup.renderOnce();
	frame = setup.captureCharFrame();
	expect(frame).toContain("2 of 2");
	expect(frame).toContain("Second queued approval.");

	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(firstActions.allow).toHaveBeenCalledWith(false);
	const remainingScrollbox = setup.renderer.root.findDescendantById(
		"approval-stack-scrollbox"
	) as ScrollBoxRenderable | undefined;
	remainingScrollbox?.scrollTo(0);
	await setup.renderOnce();
	frame = setup.captureCharFrame();
	expect(frame).toContain("Second queued approval.");
	expect(frame).not.toContain("1 of 2");
	expect(frame).not.toContain("2 of 2");
	expect(frame.match(/Permission required/gu)).toHaveLength(1);
	expect(frame).toContain("Allow once");

	await hoverAction(setup, "Reject");
	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(secondActions.abort).toHaveBeenCalledTimes(1);
	expect(secondActions.reject).not.toHaveBeenCalled();
	expect(firstActions.abort).not.toHaveBeenCalled();
	setup.renderer.destroy();
});

test("minimized dock renders only the queue head", async () => {
	const firstActions = makeActions();
	const secondActions = makeActions();
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register actions={firstActions} request={makeRequest()} />
					<Register
						actions={secondActions}
						request={makeRequest({
							description: "Second queued approval.",
							toolCallId: "call-2",
						})}
					/>
					<PendingApprovalDock />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);

	let frame = setup.captureCharFrame();
	expect(frame).toContain("1 of 2");
	expect(frame).toContain("Read a UTF-8 text file inside the workspace.");
	expect(frame).not.toContain("Second queued approval.");
	expect(frame.match(/Permission required/gu)).toHaveLength(1);
	expect(frame.match(/Allow once/gu)).toHaveLength(1);

	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(firstActions.allow).toHaveBeenCalledWith(false);
	frame = setup.captureCharFrame();
	expect(frame).toContain("Second queued approval.");
	expect(frame).not.toContain("1 of 2");
	expect(frame.match(/Permission required/gu)).toHaveLength(1);
	setup.renderer.destroy();
});

test("escape aborts the approval flow", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	setup.mockInput.pressEscape();
	await flushUi(setup);
	await flushUi(setup);

	expect(actions.abort).toHaveBeenCalledTimes(1);
	expect(actions.cancel).not.toHaveBeenCalled();
	expect(actions.allow).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain("aborted");
	setup.renderer.destroy();
});

test("the e key expands and collapses the bounded input", async () => {
	const { setup } = await renderPanel(makeRequest(), makeActions());

	expect(setup.captureCharFrame()).not.toContain('"path"');
	setup.mockInput.pressKey("e");
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain('"path"');

	setup.mockInput.pressKey("e");
	await flushUi(setup);
	expect(setup.captureCharFrame()).not.toContain('"path"');
	setup.renderer.destroy();
});

test("bounds runaway content in the panel", async () => {
	const identityTail = "RUNAWAYIDENTITY";
	const descriptionTail = "RUNAWAYDESCRIPTION";
	const inputTail = "RUNAWAYINPUT";
	const { setup } = await renderPanel(
		makeRequest({
			description: `${"y".repeat(4096)}${descriptionTail}`,
			identity: [
				{ label: "tool", value: `${"t".repeat(1024)}${identityTail}` },
				{ label: "resource", value: `${"r".repeat(1024)}${identityTail}` },
			],
			input: { path: `${"x".repeat(8192)}${inputTail}` },
		}),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain(identityTail);
	expect(frame).not.toContain(descriptionTail);
	setup.mockInput.pressKey("e");
	await flushUi(setup);
	expect(setup.captureCharFrame()).not.toContain(inputTail);
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
