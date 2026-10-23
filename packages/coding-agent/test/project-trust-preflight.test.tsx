import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect } from "react";
import type { ProjectTrustPromptRequest } from "@/modules/project-trust/project-trust";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { requestProjectTrust } from "@/tui/commands/project-trust-dialog";
import { runProjectTrustPreflight } from "@/tui/project-trust-preflight";
import {
	createRendererSession,
	type RendererSession,
} from "@/tui/renderer-session";
import { flushTestRenderer } from "./support/opentui";

const request: ProjectTrustPromptRequest = {
	parentDirectory: "/workspace",
	protectedRoots: [
		{
			currentSessionStatus: "pending",
			projectRoot: "/workspace/repo",
			savedDecision: {
				decision: "trust",
				directory: "/workspace",
				inherited: true,
			},
		},
		{
			currentSessionStatus: "pending",
			projectRoot: "/workspace/repo/nested",
			savedDecision: {
				decision: "deny",
				directory: "/workspace/repo/nested",
				inherited: false,
			},
		},
	],
	workspace: "/workspace/repo/nested",
};

const undecidedRequest: ProjectTrustPromptRequest = {
	parentDirectory: "/workspace",
	protectedRoots: [
		{
			currentSessionStatus: "pending",
			projectRoot: "/workspace/repo",
		},
		{
			currentSessionStatus: "pending",
			projectRoot: "/workspace/repo/nested",
		},
	],
	workspace: "/workspace/repo/nested",
};

const renderTrustDialog = async (
	trustRequest: ProjectTrustPromptRequest = request,
	{
		includeSessionOnly = false,
		showTrustStatus = true,
		homeRoot,
	}: Readonly<{
		includeSessionOnly?: boolean;
		showTrustStatus?: boolean;
		homeRoot?: string;
	}> = {}
) => {
	let selectionOutcome: Promise<
		| Readonly<{ kind: "selected"; choice: string }>
		| Readonly<{ kind: "cancelled" }>
		| Readonly<{ kind: "rejected"; error: unknown }>
	> = Promise.resolve({ kind: "cancelled" });

	function Harness() {
		const { open } = useDialog();
		useEffect(() => {
			selectionOutcome = requestProjectTrust(
				{ open },
				{ ...trustRequest, includeSessionOnly, showTrustStatus, homeRoot }
			).then(
				(choice) =>
					choice === "cancel"
						? ({ kind: "cancelled" } as const)
						: ({ kind: "selected", choice } as const),
				(error: unknown) => ({ kind: "rejected", error }) as const
			);
		}, [open]);
		return null;
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
	await flushTestRenderer(setup, 3);
	return {
		setup,
		selectionOutcome: () => selectionOutcome,
	};
};

test("startup trust cancellation keeps the shared renderer alive", async () => {
	const priorActEnvironment = Reflect.get(
		globalThis,
		"IS_REACT_ACT_ENVIRONMENT"
	);
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	let setup: TestRendererSetup | undefined;
	let rendererSession: RendererSession | undefined;
	let nativeRendererDestroyed = false;
	try {
		const testSetup = await createTestRenderer({ height: 40, width: 120 });
		setup = testSetup;
		const destroy = testSetup.renderer.destroy.bind(testSetup.renderer);
		testSetup.renderer.destroy = () => {
			nativeRendererDestroyed = true;
			destroy();
		};
		rendererSession = await createRendererSession(
			async () => testSetup.renderer
		);
		const workspaceOnlyRequest: ProjectTrustPromptRequest = {
			...request,
			protectedRoots: request.protectedRoots.filter(
				({ projectRoot }) => projectRoot === request.workspace
			),
		};
		const preflight = runProjectTrustPreflight(
			workspaceOnlyRequest,
			rendererSession
		);
		await flushTestRenderer(testSetup, 3);
		const startupFrame = testSetup.captureCharFrame();
		expect(startupFrame).not.toContain("Saved decision:");
		expect(startupFrame).not.toContain("Current session:");
		expect(startupFrame).toContain("Trust (this session only)");
		const startupLines = startupFrame.split("\n");
		const workspaceLine = startupLines.findIndex((line) =>
			line.includes("Workspace:")
		);
		const choiceLine = startupLines.findIndex((line) =>
			line.includes("Trust (this session only)")
		);
		expect(choiceLine - workspaceLine).toBeLessThanOrEqual(4);
		await act(() => testSetup.mockInput.pressEscape());
		await flushTestRenderer(testSetup, 2);
		let choice: Awaited<typeof preflight> | undefined;
		await act(async () => {
			choice = await preflight;
		});
		expect(choice).toBe("cancel");
		expect(nativeRendererDestroyed).toBe(false);
		await flushTestRenderer(testSetup, 2);
		const frame = testSetup.captureCharFrame();
		expect(frame).not.toContain("Starting Wincode…");
		expect(frame.trim()).toBe("");
	} finally {
		const session = rendererSession;
		if (session === undefined) {
			const testSetup = setup;
			if (testSetup !== undefined) {
				await act(() => testSetup.renderer.destroy());
			}
		} else {
			await act(() => session.destroy());
		}
		if (priorActEnvironment === undefined) {
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		} else {
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironment);
		}
	}
	expect(nativeRendererDestroyed).toBe(true);
});

test("trust selector lists each root and its saved decision", async () => {
	const { setup } = await renderTrustDialog();
	try {
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Protected root: /workspace/repo");
		expect(frame).not.toContain("Protected root: /workspace/repo/nested");
		expect(frame).toContain("/workspace/repo/nested");
		expect(frame).toContain(
			"Saved decision: trusted (inherited from /workspace)"
		);
		expect(frame).toContain("Saved decision: untrusted");
		expect(frame).toContain("Current session: pending");
		expect(frame).toContain("Trust parent folder (/workspace)");
		expect(frame).toContain("Do not trust");
		expect(frame).toContain(
			"Allow this project's protected resources to load."
		);
		expect(frame).toContain("↑↓ navigate");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trust selector resolves Escape as cancellation instead of rejecting", async () => {
	const { selectionOutcome, setup } = await renderTrustDialog();
	try {
		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(await selectionOutcome()).toEqual({ kind: "cancelled" });
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trust selector offers session-only choices only to the startup prompt", async () => {
	const management = await renderTrustDialog(undecidedRequest);
	try {
		const frame = management.setup.captureCharFrame();
		expect(frame).not.toContain("Trust (this session only)");
		expect(frame).not.toContain("Do not trust (this session only)");
		expect(frame).toContain("Saved decision: none");
	} finally {
		await act(() => management.setup.renderer.destroy());
	}

	const startup = await renderTrustDialog(request, {
		includeSessionOnly: true,
		showTrustStatus: false,
	});
	try {
		const frame = startup.setup.captureCharFrame();
		expect(frame).toContain("Trust (this session only)");
		expect(frame).toContain("Do not trust (this session only)");
		expect(frame).not.toContain("Saved decision:");
		expect(frame).not.toContain("Current session:");
	} finally {
		await act(() => startup.setup.renderer.destroy());
	}
});

test("trust selector abbreviates home paths in details and parent choices", async () => {
	const homeRoot = path.join(os.tmpdir(), "wincode-trust-selector-home");
	const parentDirectory = path.join(homeRoot, "workspace");
	const projectRoot = path.join(parentDirectory, "repo");
	const workspace = path.join(projectRoot, "nested");
	const { setup } = await renderTrustDialog(
		{
			parentDirectory,
			protectedRoots: [
				{
					currentSessionStatus: "pending",
					projectRoot,
					savedDecision: {
						decision: "trust",
						directory: parentDirectory,
						inherited: true,
					},
				},
			],
			workspace,
		},
		{ homeRoot }
	);
	try {
		const frame = setup.captureCharFrame();
		expect(frame).toContain(
			`Workspace: ~${path.sep}workspace${path.sep}repo${path.sep}nested`
		);
		expect(frame).toContain(
			`Protected root: ~${path.sep}workspace${path.sep}repo`
		);
		expect(frame).toContain(
			`Saved decision: trusted (inherited from ~${path.sep}workspace)`
		);
		expect(frame).toContain(`Trust parent folder (~${path.sep}workspace)`);
		expect(frame).not.toContain(parentDirectory);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trust selector treats Ctrl+C as cancellation", async () => {
	const { selectionOutcome, setup } = await renderTrustDialog();
	try {
		await act(() => setup.mockInput.pressCtrlC());
		await flushTestRenderer(setup, 2);
		expect(await selectionOutcome()).toEqual({ kind: "cancelled" });
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trust selector returns the parent-trust choice selected with the keyboard", async () => {
	const { selectionOutcome, setup } = await renderTrustDialog();
	try {
		await act(() => setup.mockInput.pressArrow("down"));
		await flushTestRenderer(setup, 2);
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 2);
		expect(await selectionOutcome()).toEqual({
			kind: "selected",
			choice: "trust-parent",
		});
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trust selector returns the session-only choice selected with the keyboard", async () => {
	const { selectionOutcome, setup } = await renderTrustDialog(request, {
		includeSessionOnly: true,
		showTrustStatus: false,
	});
	try {
		await act(() => setup.mockInput.pressArrow("down"));
		await flushTestRenderer(setup, 2);
		await act(() => setup.mockInput.pressArrow("down"));
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain(
			"Load protected resources until Wincode exits; save no decision."
		);
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 2);
		expect(await selectionOutcome()).toEqual({
			kind: "selected",
			choice: "trust-session",
		});
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
