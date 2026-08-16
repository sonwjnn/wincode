import { expect, mock, test } from "bun:test";
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
import { ToolApprovalPanel } from "./tool-approval-panel";

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
	actions: ToolApprovalActions
): Promise<PanelSetup> => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register actions={actions} request={request} />
					<ToolApprovalPanel id={request.toolCallId ?? "call-1"} />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return { actions, setup };
};

test("renders a compact inline header with options and no dialog chrome", async () => {
	const { setup } = await renderPanel(makeRequest(), makeActions());
	const frame = setup.captureCharFrame();

	expect(frame).toContain(
		"tool: read · resource: .env — Read a UTF-8 text file inside the workspace."
	);
	expect(frame).toContain("Allow once");
	expect(frame).toContain("Always allow");
	expect(frame).toContain("Reject");
	// The inline panel replaces the modal dialog: no title, no always-visible
	// feedback field, and the input stays collapsed until expanded.
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

	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(true);
	expect(setup.captureCharFrame()).toContain("always allowed");
	setup.renderer.destroy();
});

test("rapid keyboard selection resolves against the latest option", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

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

test("reject reveals the optional feedback input and settles with feedback", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("feedback (optional)");

	await setup.mockInput.typeText("use the config loader");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.reject).toHaveBeenCalledTimes(1);
	const feedback = (actions.reject as ReturnType<typeof mock>).mock
		.calls[0]?.[0];
	expect(feedback).toContain("use the config loader");
	expect(actions.allow).not.toHaveBeenCalled();
	const frame = setup.captureCharFrame();
	expect(frame).toContain("rejected");
	expect(frame).toContain("use the config loader");
	setup.renderer.destroy();
});

test("rejecting without feedback settles with reject(undefined)", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.reject).toHaveBeenCalledWith(undefined);
	expect(setup.captureCharFrame()).toContain("rejected");
	setup.renderer.destroy();
});

test("rejecting one panel settles sibling panels to their audit lines", async () => {
	// The last registered panel owns the keyboard layer, so the keys drive the
	// sibling; the earlier panel's actions must never be invoked because the
	// registry-wide rejection settles it without touching its queue handle.
	const firstActions = makeActions();
	const siblingActions = makeActions();
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register actions={firstActions} request={makeRequest()} />
					<Register
						actions={siblingActions}
						request={makeRequest({ toolCallId: "call-2" })}
					/>
					<ToolApprovalPanel id="call-1" />
					<ToolApprovalPanel id="call-2" />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);

	// Reject on the top panel: the queue rejects every pending approval in the
	// conversation, so the earlier panel collapses to its audit line too and is
	// no longer interactive.
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);
	await flushUi(setup);

	expect(siblingActions.reject).toHaveBeenCalledWith(undefined);
	expect(firstActions.reject).not.toHaveBeenCalled();
	expect(firstActions.allow).not.toHaveBeenCalled();
	const frame = setup.captureCharFrame();
	expect(frame).toContain("rejected");
	expect(frame).not.toContain("Allow once");
	expect(frame).not.toContain("Always allow");
	setup.renderer.destroy();
});

test("escape cancels the pending request and collapses to rejected", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	setup.mockInput.pressEscape();
	// Escape settles the request; a second flush commits the collapsed line.
	await flushUi(setup);
	await flushUi(setup);

	expect(actions.cancel).toHaveBeenCalled();
	expect(actions.allow).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain("rejected");
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
