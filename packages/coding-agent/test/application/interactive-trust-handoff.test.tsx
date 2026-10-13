import { expect, test } from "bun:test";
import type { createCliRenderer } from "@opentui/core";
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@opentui/core/testing";
import { act } from "react";
import type { ProjectTrustPromptRequest } from "@/modules/project-trust/project-trust";
import { runProjectTrustPreflight } from "@/tui/project-trust-preflight";
import { createModeRunnerLoader } from "../../bin/mode-runners";
import { flushTestRenderer } from "../support/opentui";

test("startup trust prompt and app reuse one renderer and destroy it once", async () => {
	let rendererFactoryCalls = 0;
	let nativeDestroyCalls = 0;
	let testSetup: TestRendererSetup | undefined;
	const rendererFactory: typeof createCliRenderer = async (options) => {
		rendererFactoryCalls += 1;
		const setup = await createTestRenderer({
			...options,
			height: 40,
			width: 120,
		});
		testSetup = setup;
		const destroy = setup.renderer.destroy.bind(setup.renderer);
		setup.renderer.destroy = () => {
			nativeDestroyCalls += 1;
			destroy();
		};
		return setup.renderer;
	};
	const trustRequest: ProjectTrustPromptRequest = {
		protectedRoots: [
			{
				currentSessionStatus: "pending",
				projectRoot: "/workspace/repo",
			},
		],
		workspace: "/workspace/repo",
	};
	const runners = await createModeRunnerLoader({
		promptProjectTrust: runProjectTrustPreflight,
		rendererFactory,
		runInteractive: async (session) => {
			session.render(<text>Wincode App</text>);
			return 0;
		},
	})("interactive");
	const promptProjectTrust = runners.promptProjectTrust;
	const setup = testSetup;
	if (promptProjectTrust === undefined || setup === undefined) {
		throw new Error("Interactive startup did not prepare the trust renderer.");
	}

	try {
		await flushTestRenderer(setup, 3);
		const initialFrame = setup.captureCharFrame();
		expect(initialFrame).not.toContain("Starting Wincode…");
		expect(initialFrame.trim()).toBe("");

		const choice = promptProjectTrust(trustRequest);
		await flushTestRenderer(setup, 3);
		expect(setup.captureCharFrame()).toContain("Project Trust");
		await act(() => setup.mockInput.pressEnter());
		expect(await choice).toBe("trust");
		expect(nativeDestroyCalls).toBe(0);

		await runners.interactive({
			args: [],
			cwd: "/workspace/repo",
			invocation: { mode: "interactive" },
			stderr: { write: () => undefined },
			stdinIsTTY: true,
			stdout: { write: () => undefined },
		});
		await flushTestRenderer(setup, 3);
		expect(setup.captureCharFrame()).toContain("Wincode App");
		expect(setup.captureCharFrame()).not.toContain("Project Trust");
		expect(rendererFactoryCalls).toBe(1);
		expect(nativeDestroyCalls).toBe(0);
	} finally {
		await runners.cleanup?.();
	}

	expect(nativeDestroyCalls).toBe(1);
});
