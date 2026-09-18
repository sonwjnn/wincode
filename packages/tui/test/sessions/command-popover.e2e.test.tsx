import { isUndefined } from "@wincode/runtime-utils";

const previousEnvironment = {
	WINCODE_E2E_HOME: process.env.WINCODE_E2E_HOME,
	WINCODE_E2E_WORKSPACE: process.env.WINCODE_E2E_WORKSPACE,
	WINCODE_LOCAL_DB_PATH: process.env.WINCODE_LOCAL_DB_PATH,
	WINCODE_MODEL_PRICING_OFFLINE: process.env.WINCODE_MODEL_PRICING_OFFLINE,
};

const restoreEnvironment = (): void => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (isUndefined(value)) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
};

process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

import { afterAll, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
} from "@/test/support/e2e-fake-runtime";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-command-popover-e2e-")
);
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
await Promise.all([
	mkdir(join(testDirectory, ".git"), { recursive: true }),
	mkdir(join(testDirectory, ".wincode", "skills", "review"), {
		recursive: true,
	}),
]);
await writeFile(
	join(testDirectory, ".wincode", "skills", "review", "SKILL.md"),
	"---\nname: review\ndescription: Reviews implementation\n---\nReview the implementation carefully."
);
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const recorder = createFakeAiSdkRecorder();
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder)
);

// The module mock must be installed before the production SessionView graph loads.
const {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	renderSession,
	seedCompactionHistory,
	settleSessionUi,
	waitForSessionFrame,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");

const store = createE2eStore();
const { messages, sessionId } = await seedCompactionHistory(store, 2);

test("lists merged command rows and activates a skill typed through its namespace", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			initialTranscript: messages,
			pricing: createE2ePricing(20_000),
			sessionId,
		});
		const activeSetup = rendered.setup;
		setup = activeSetup;
		await rendered.registryReady;
		await act(async () => {
			await activeSetup.flush();
			await activeSetup.flush();
		});

		await act(async () => {
			await activeSetup.mockInput.typeText("/");
		});
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("Start a new session"),
				{ maxPasses: 200 }
			);
		});
		// Built-in Commands lead the merged list, so the Skill rows sit past the
		// eight-row window while the query is empty.
		const emptyQueryFrame = activeSetup.captureCharFrame();
		expect(emptyQueryFrame).toContain("Start a new session");
		expect(emptyQueryFrame).not.toContain("skill:review");

		await act(async () => {
			await activeSetup.mockInput.typeText("mo");
		});
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("Select AI model for generation"),
				{ maxPasses: 200 }
			);
		});
		const builtinRowFrame = activeSetup.captureCharFrame();
		expect(builtinRowFrame).toContain("models");
		expect(builtinRowFrame).not.toContain("/models");

		await act(async () => {
			await activeSetup.mockInput.pressKeys([
				"BACKSPACE",
				"BACKSPACE",
				"BACKSPACE",
			]);
		});
		await act(async () => {
			await activeSetup.mockInput.typeText("/skill:rev");
		});
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("skill:review"),
				{ maxPasses: 200 }
			);
		});
		const skillRowFrame = activeSetup.captureCharFrame();
		expect(skillRowFrame).toContain("skill:review");
		expect(skillRowFrame).toContain("Reviews implementation");

		// Enter runs the selected row, which writes the namespaced invocation.
		await act(() => activeSetup.mockInput.pressEnter());
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain("/skill:review ");

		await act(async () => {
			await activeSetup.mockInput.typeText("focus on auth");
		});
		await settleSessionUi(activeSetup);
		await act(() => activeSetup.mockInput.pressEnter());
		// The cleared composer plus the activation row prove the invocation
		// resolved to a Skill instead of ordinary prompt text: both arrive with
		// the submission, after the send path settles.
		await waitForSessionFrame(
			activeSetup,
			(frame) => frame.includes("Ask anything") && frame.includes("Skill")
		);
		const submittedFrame = activeSetup.captureCharFrame();
		expect(submittedFrame).toContain("/skill:review focus on auth");
		expect(submittedFrame).toContain("review");
	} finally {
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
