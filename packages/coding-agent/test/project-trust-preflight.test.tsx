import { expect, test } from "bun:test";
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

const renderTrustDialog = async (
	trustRequest: ProjectTrustPromptRequest = request
) => {
	let selectionOutcome: Promise<
		| Readonly<{ kind: "selected"; choice: string }>
		| Readonly<{ kind: "cancelled" }>
	> = Promise.resolve({ kind: "cancelled" });

	function Harness() {
		const { open } = useDialog();
		useEffect(() => {
			selectionOutcome = requestProjectTrust({ open }, trustRequest).then(
				(choice) => ({ kind: "selected", choice }),
				() => ({ kind: "cancelled" })
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

test("startup preflight returns cancellation and tears down its renderer", async () => {
	const priorActEnvironment = Reflect.get(
		globalThis,
		"IS_REACT_ACT_ENVIRONMENT"
	);
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	let setup: TestRendererSetup | undefined;
	try {
		const testSetup = await createTestRenderer({ height: 40, width: 120 });
		setup = testSetup;
		let nativeRendererDestroyed = false;
		const destroy = testSetup.renderer.destroy.bind(testSetup.renderer);
		testSetup.renderer.destroy = () => {
			nativeRendererDestroyed = true;
			destroy();
		};
		const preflight = runProjectTrustPreflight(
			request,
			async () => testSetup.renderer
		);
		await flushTestRenderer(testSetup, 3);
		expect(testSetup.captureCharFrame()).toContain(
			"Current session: Decision pending"
		);
		await act(() => testSetup.mockInput.pressEscape());
		await flushTestRenderer(testSetup, 2);
		let choice: Awaited<typeof preflight> | undefined;
		await act(async () => {
			choice = await preflight;
		});
		expect(choice).toBe("cancel");
		expect(nativeRendererDestroyed).toBe(true);
	} finally {
		const testSetup = setup;
		if (testSetup !== undefined) {
			await act(() => testSetup.renderer.destroy());
		}
		if (priorActEnvironment === undefined) {
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		} else {
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironment);
		}
	}
});

test("trust selector lists each root and pending session state; Escape cancels", async () => {
	const { selectionOutcome, setup } = await renderTrustDialog();
	try {
		const frame = setup.captureCharFrame();
		expect(frame).toContain("/workspace/repo");
		expect(frame).toContain("/workspace/repo/nested");
		expect(frame).toContain(
			"Saved decision: trusted (inherited from /workspace)"
		);
		expect(frame).toContain("Saved decision: untrusted");
		expect(frame).toContain("Current session: Decision pending");
		expect(frame).toContain("Trust parent folder (/workspace)");
		expect(frame).toContain("Do not trust");

		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(await selectionOutcome()).toEqual({ kind: "cancelled" });
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

test("trust selector reports loaded status separately for each protected root", async () => {
	const { setup } = await renderTrustDialog({
		...request,
		protectedRoots: [
			{
				currentSessionStatus: "trusted",
				projectRoot: "/workspace/repo",
			},
			{
				currentSessionStatus: "untrusted",
				projectRoot: "/workspace/repo/nested",
			},
		],
	});
	try {
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Current session: trusted");
		expect(frame).toContain("Current session: untrusted");
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
