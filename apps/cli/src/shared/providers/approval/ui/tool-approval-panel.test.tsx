import { expect, mock, test } from "bun:test";
import type { ScrollBoxRenderable, Selection } from "@opentui/core";
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
	pendingCount = 1,
	errorText?: string
): Promise<PanelSetup> => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register actions={actions} request={request} />
					<ToolApprovalPanel
						errorText={errorText}
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

test("selecting always requires a second confirm before granting", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	await hoverAction(setup, "Always allow");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	// The first enter only arms the confirm: no grant is minted yet.
	expect(actions.allow).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain(
		"Always allow lets this tool run without asking again."
	);

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

	// Enter resolves against the hovered option: the always confirm arms for it.
	expect(setup.captureCharFrame()).toContain(
		"Always allow lets this tool run without asking again."
	);

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(true);
	setup.renderer.destroy();
});

test("a click on the overlay confirm button grants", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());
	const locate = (
		label: string,
		alsoOnRow: string
	): { column: number; row: number } => {
		// The disambiguator tells the option bar from the overlay buttons row:
		// the panel row carries "Reject", the overlay row carries "Cancel".
		const rows = setup.captureCharFrame().split("\n");
		const row = rows.findIndex(
			(candidate) => candidate.includes(label) && candidate.includes(alsoOnRow)
		);
		const column = rows[row]?.indexOf(label) ?? -1;
		expect(row).toBeGreaterThanOrEqual(0);
		expect(column).toBeGreaterThanOrEqual(0);
		return { column, row };
	};

	// Clicking the panel's always option only arms the confirm overlay.
	const panelButton = locate("Always allow", "Reject");
	await setup.mockMouse.click(panelButton.column, panelButton.row);
	await flushUi(setup);
	expect(actions.allow).not.toHaveBeenCalled();
	const overlayFrame = setup.captureCharFrame();
	expect(overlayFrame).toContain(
		"Always allow lets this tool run without asking again."
	);
	// The overlay is pushed on top of the permission block and the panel's
	// action bar is unmounted: its options and hints are not rendered at all.
	expect(overlayFrame).toContain("Cancel");
	expect(overlayFrame).not.toContain("Reject");
	expect(overlayFrame).not.toContain("ctrl+f");

	// Clicking the overlay's confirm button grants.
	const overlayButton = locate("Confirm", "Cancel");
	await setup.mockMouse.click(overlayButton.column, overlayButton.row);
	await flushUi(setup);

	expect(actions.allow).toHaveBeenCalledWith(true);
	expect(setup.captureCharFrame()).toContain("always allowed");
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
test("strips the repeated resource from the resolved audit line", async () => {
	const { setup } = await renderPanel(
		makeRequest(),
		makeActions(),
		1,
		"Read was not approved: .env"
	);

	await hoverAction(setup, "Reject");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	const frame = setup.captureCharFrame();
	expect(frame).toContain("✗ Read was not approved");
	expect(frame).not.toContain("Read was not approved: .env");
	expect(frame).not.toContain("✗ rejected");
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

test("confirming always on the head does not leak the overlay into the next request", async () => {
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

	// Arm the overlay on the head request and confirm the always grant.
	await hoverAction(setup, "Always allow");
	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain(
		"Always allow lets this tool run without asking again."
	);
	setup.mockInput.pressEnter();
	await flushUi(setup);
	await flushUi(setup);

	expect(firstActions.allow).toHaveBeenCalledWith(true);

	// The next queued request presents the plain permission panel again: the
	// overlay must not carry over to a request the user never armed.
	const frame = setup.captureCharFrame();
	expect(frame).toContain("Second queued approval.");
	expect(frame).toContain("Permission required");
	expect(frame).toContain("Allow once");
	expect(frame).not.toContain("Always allow lets this tool run");
	setup.renderer.destroy();
});

test("micro-drag over an action button never selects or copies", async () => {
	const { setup } = await renderPanel(makeRequest(), makeActions());
	const selections: string[] = [];
	(
		setup.renderer as unknown as {
			on(event: string, listener: (selection: Selection) => void): void;
		}
	).on("selection", (selection) => {
		selections.push(selection.getSelectedText());
	});

	// A sloppy click drifts across the label cells; the label must not start a
	// selection, so the copy-on-select surface never sees it.
	const rows = setup.captureCharFrame().split("\n");
	const row = rows.findIndex(
		(candidate) =>
			candidate.includes("Always allow") && candidate.includes("Reject")
	);
	const column = rows[row]?.indexOf("Always allow") ?? -1;
	expect(row).toBeGreaterThanOrEqual(0);
	expect(column).toBeGreaterThanOrEqual(0);

	await setup.mockMouse.moveTo(column, row);
	await setup.mockMouse.pressDown(column, row);
	await setup.mockMouse.moveTo(column + 2, row);
	await setup.mockMouse.release(column + 2, row);
	await flushUi(setup);

	expect(selections).toEqual([]);
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

test("escape cancels an armed always-allow confirm without aborting", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	await hoverAction(setup, "Always allow");
	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain(
		"Always allow lets this tool run without asking again."
	);

	setup.mockInput.pressEscape();
	await flushUi(setup);
	await flushUi(setup);

	expect(actions.abort).not.toHaveBeenCalled();
	expect(actions.allow).not.toHaveBeenCalled();
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("Always allow lets this tool run");
	expect(frame).toContain("Always allow");

	// Re-arming with enter still requires the second confirm before granting.
	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(actions.allow).not.toHaveBeenCalled();
	expect(setup.captureCharFrame()).toContain(
		"Always allow lets this tool run without asking again."
	);
	setup.renderer.destroy();
});

test("the overlay cancel action pops back without granting", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions());

	await hoverAction(setup, "Always allow");
	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain(
		"Always allow lets this tool run without asking again."
	);

	// The overlay owns the keyboard layer while armed: arrow onto the Cancel
	// button and enter pops the overlay back to the permission panel without
	// granting or aborting the turn.
	setup.mockInput.pressArrow("right");
	await flushUi(setup);
	setup.mockInput.pressEnter();
	await flushUi(setup);
	await flushUi(setup);

	expect(actions.allow).not.toHaveBeenCalled();
	expect(actions.abort).not.toHaveBeenCalled();
	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("Always allow lets this tool run");
	expect(frame).toContain("Always allow");
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
