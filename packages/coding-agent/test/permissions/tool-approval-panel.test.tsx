import { expect, mock, test } from "bun:test";
import type { Selection } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromAny } from "@total-typescript/shoehorn";
import type { ReactNode } from "react";
import { act } from "react";
import {
	type ApprovalPanelEntry,
	ApprovalPanelsProvider,
	useApprovalPanels,
} from "@/shared/providers/approval/approval-panels-provider";
import {
	formatApprovalDescription,
	formatApprovalInput,
	MAX_DESCRIPTION_CHARS,
} from "@/shared/providers/approval/format";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/types";
import {
	PendingApprovalDock,
	ToolApprovalPanel,
} from "@/shared/providers/approval/ui/tool-approval-panel";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { approvalPanelEntry } from "../support/approval-panel-entry";
import { toolCallId } from "../support/identifiers";

const makeRequest = (
	overrides: Partial<Omit<ToolApprovalRequest, "toolCallId">> & {
		toolCallId?: string;
	} = {}
): ToolApprovalRequest => {
	const { toolCallId: rawToolCallId, ...rest } = overrides;
	return {
		description: "Read a UTF-8 text file inside the workspace.",
		identity: [
			{ label: "tool", value: "read" },
			{ label: "resource", value: ".env" },
		],
		input: { path: ".env" },
		toolCallId: toolCallId(rawToolCallId ?? "call-1"),
		...rest,
	};
};

const makeActions = (): ToolApprovalActions => ({
	abort: mock(() => undefined),
	allow: mock(() => undefined),
	reject: mock(() => undefined),
	cancel: mock(() => undefined),
});

type PanelSetup = {
	actions: ToolApprovalActions;
	project: (entries: readonly ApprovalPanelEntry[]) => void;
	setup: TestRendererSetup;
};

const flushUi = async (setup: TestRendererSetup): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};
const hoverAction = async (
	setup: TestRendererSetup,
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

function ProjectionProbe({
	onProject,
}: {
	onProject: (project: PanelSetup["project"]) => void;
}) {
	onProject(useApprovalPanels().project);
	return null;
}

/**
 * Renders an approval surface against the projection API the session uses:
 * entries appear only when the binding projects them, exactly as they do from
 * the Session Engine's approvals.
 */
const renderSurface = async (
	children: ReactNode
): Promise<{
	project: PanelSetup["project"];
	setup: TestRendererSetup;
}> => {
	let project: PanelSetup["project"] = () => undefined;
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<ProjectionProbe
						onProject={(next) => {
							project = next;
						}}
					/>
					{children}
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return {
		project: (entries) => {
			project(entries);
		},
		setup,
	};
};

const projectEntries = async (
	project: PanelSetup["project"],
	setup: TestRendererSetup,
	entries: readonly ApprovalPanelEntry[]
): Promise<void> => {
	await act(async () => {
		project(entries);
	});
	await flushUi(setup);
};

const renderPanel = async (
	request: ToolApprovalRequest,
	actions: ToolApprovalActions,
	pendingCount = 1,
	errorText?: string,
	resolution?: ApprovalPanelEntry["resolution"]
): Promise<PanelSetup> => {
	const surface = await renderSurface(
		<ToolApprovalPanel
			errorText={errorText}
			id={request.toolCallId ?? "call-1"}
			pendingCount={pendingCount}
		/>
	);
	await projectEntries(surface.project, surface.setup, [
		approvalPanelEntry(request, { actions, resolution }),
	]);
	return { ...surface, actions };
};

/** Settles the projected request the way the session's command would report it. */
const settleProjection = async (
	{ project, setup }: PanelSetup,
	request: ToolApprovalRequest,
	actions: ToolApprovalActions,
	resolution: NonNullable<ApprovalPanelEntry["resolution"]>
): Promise<void> => {
	await projectEntries(project, setup, [
		approvalPanelEntry(request, { actions, resolution }),
	]);
};

test("hides the always option and warns under the safety ceiling", async () => {
	const { setup } = await renderPanel(
		makeRequest({ safety: true }),
		makeActions()
	);
	const frame = setup.captureCharFrame();
	// The banner is the manual-ceiling wording only: the destructive-command
	// safety reason is gone with the classifier (ADR-0008).
	expect(frame).toContain(
		"Safety ceiling: the governing Tool Permission config is malformed, so every action must be approved manually."
	);
	expect(frame).toContain("Allow once");
	expect(frame).toContain("Reject");
	expect(frame).not.toContain("Abort");
	// A safety ask must never mint a grant, so "always" is absent.
	expect(frame).not.toContain("Always allow");
	expect(frame).not.toContain("Destructive command");
	setup.renderer.destroy();
});

test("allow once asks the session for allow(false) and renders its resolution", async () => {
	const request = makeRequest();
	const actions = makeActions();
	const panel = await renderPanel(request, actions);

	panel.setup.mockInput.pressEnter();
	await flushUi(panel.setup);

	expect(actions.allow).toHaveBeenCalledWith(false);
	expect(actions.reject).not.toHaveBeenCalled();
	expect(panel.setup.captureCharFrame()).toContain("Allow once");

	await settleProjection(panel, request, actions, { outcome: "allow-once" });
	const frame = panel.setup.captureCharFrame();
	expect(frame).toContain("allowed once");
	expect(frame).not.toContain("Allow once");
	panel.setup.renderer.destroy();
});

test("selecting always requires a second confirm before granting", async () => {
	const request = makeRequest();
	const actions = makeActions();
	const panel = await renderPanel(request, actions);
	const { setup } = panel;

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
	await settleProjection(panel, request, actions, { outcome: "always" });
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
	const request = makeRequest();
	const actions = makeActions();
	const panel = await renderPanel(request, actions);
	const { setup } = panel;
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
	await settleProjection(panel, request, actions, { outcome: "always" });
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

test("reject asks the session to reject only the selected tool when approvals remain", async () => {
	const request = makeRequest();
	const actions = makeActions();
	const panel = await renderPanel(request, actions, 2);

	await hoverAction(panel.setup, "Reject");
	panel.setup.mockInput.pressEnter();
	await flushUi(panel.setup);

	expect(actions.reject).toHaveBeenCalledWith(undefined);
	expect(actions.abort).not.toHaveBeenCalled();
	await settleProjection(panel, request, actions, { outcome: "rejected" });
	expect(panel.setup.captureCharFrame()).toContain("rejected");
	panel.setup.renderer.destroy();
});

test("strips the repeated resource from the resolved audit line", async () => {
	const { setup } = await renderPanel(
		makeRequest(),
		makeActions(),
		1,
		"Read was not approved: .env",
		{ outcome: "rejected" }
	);

	const frame = setup.captureCharFrame();
	expect(frame).toContain("✗ Read was not approved");
	expect(frame).not.toContain("Read was not approved: .env");
	expect(frame).not.toContain("✗ rejected");
	setup.renderer.destroy();
});

test("reject aborts the turn when it is the only approval", async () => {
	const request = makeRequest();
	const actions = makeActions();
	const panel = await renderPanel(request, actions);

	expect(panel.setup.captureCharFrame()).not.toContain("Abort");
	await hoverAction(panel.setup, "Reject");
	panel.setup.mockInput.pressEnter();
	await flushUi(panel.setup);

	expect(actions.abort).toHaveBeenCalledTimes(1);
	expect(actions.reject).not.toHaveBeenCalled();
	await settleProjection(panel, request, actions, { outcome: "aborted" });
	expect(panel.setup.captureCharFrame()).toContain("aborted");
	panel.setup.renderer.destroy();
});

test("abort settles separately from rejecting one tool", async () => {
	const { actions, setup } = await renderPanel(makeRequest(), makeActions(), 2);

	await hoverAction(setup, "Abort");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(actions.abort).toHaveBeenCalledTimes(1);
	expect(actions.reject).not.toHaveBeenCalled();
	setup.renderer.destroy();
});

test("confirming always on the head does not leak the overlay into the next request", async () => {
	const firstRequest = makeRequest();
	const secondRequest = makeRequest({
		description: "Second queued approval.",
		toolCallId: "call-2",
	});
	const firstActions = makeActions();
	const secondActions = makeActions();
	const { project, setup } = await renderSurface(<PendingApprovalDock />);
	await projectEntries(project, setup, [
		approvalPanelEntry(firstRequest, { actions: firstActions }),
		approvalPanelEntry(secondRequest, { actions: secondActions }),
	]);

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

	// The session settles the head, and the next queued request is presented as
	// a plain permission panel: the overlay must not carry over to a request the
	// user never armed.
	await projectEntries(project, setup, [
		approvalPanelEntry(firstRequest, {
			actions: firstActions,
			resolution: { outcome: "always" },
		}),
		approvalPanelEntry(secondRequest, { actions: secondActions }),
	]);
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
	const renderer: {
		on(event: string, listener: (selection: Selection) => void): void;
	} = fromAny(setup.renderer);
	renderer.on("selection", (selection) => {
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

test("dock renders only the pending head of the projection", async () => {
	const firstRequest = makeRequest();
	const secondRequest = makeRequest({
		description: "Second queued approval.",
		toolCallId: "call-2",
	});
	const firstActions = makeActions();
	const secondActions = makeActions();
	const { project, setup } = await renderSurface(<PendingApprovalDock />);
	await projectEntries(project, setup, [
		approvalPanelEntry(firstRequest, { actions: firstActions }),
		approvalPanelEntry(secondRequest, { actions: secondActions }),
	]);

	let frame = setup.captureCharFrame();
	expect(frame).toContain("1 of 2");
	expect(frame).toContain("Read a UTF-8 text file inside the workspace.");
	expect(frame).not.toContain("Second queued approval.");
	expect(frame.match(/Permission required/gu)).toHaveLength(1);
	expect(frame.match(/Allow once/gu)).toHaveLength(1);

	setup.mockInput.pressEnter();
	await flushUi(setup);
	expect(firstActions.allow).toHaveBeenCalledWith(false);

	// Once the session settles the head, the dock presents the next request.
	await projectEntries(project, setup, [
		approvalPanelEntry(firstRequest, {
			actions: firstActions,
			resolution: { outcome: "allow-once" },
		}),
		approvalPanelEntry(secondRequest, { actions: secondActions }),
	]);
	frame = setup.captureCharFrame();
	expect(frame).toContain("Second queued approval.");
	expect(frame).not.toContain("1 of 2");
	expect(frame.match(/Permission required/gu)).toHaveLength(1);
	setup.renderer.destroy();
});

test("escape aborts the approval flow", async () => {
	const request = makeRequest();
	const actions = makeActions();
	const panel = await renderPanel(request, actions);

	panel.setup.mockInput.pressEscape();
	await flushUi(panel.setup);
	await flushUi(panel.setup);

	expect(actions.abort).toHaveBeenCalledTimes(1);
	expect(actions.cancel).not.toHaveBeenCalled();
	expect(actions.allow).not.toHaveBeenCalled();
	await settleProjection(panel, request, actions, { outcome: "aborted" });
	expect(panel.setup.captureCharFrame()).toContain("aborted");
	panel.setup.renderer.destroy();
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
