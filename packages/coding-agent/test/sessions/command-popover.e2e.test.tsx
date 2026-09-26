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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";
import { getFileMentionOptions } from "@/modules/file-mentions";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-command-popover-e2e-")
);
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
const mentionFixtureDirectory = await mkdtemp(
	join(process.cwd(), "packages/coding-agent/test/mention-e2e-")
);
const mentionFixturePath = mentionFixtureDirectory.slice(
	process.cwd().length + 1
);
await mkdir(join(mentionFixtureDirectory, "utils", "empty"), {
	recursive: true,
});
await Bun.write(
	join(mentionFixtureDirectory, "utils", "child.ts"),
	"export const child = true;"
);
await Promise.all([
	mkdir(join(testDirectory, ".git"), { recursive: true }),
	mkdir(join(testDirectory, ".wincode", "skills", "model-4o"), {
		recursive: true,
	}),
]);
await Bun.write(
	join(testDirectory, ".wincode", "skills", "model-4o", "SKILL.md"),
	"---\nname: model-4o\ndescription: Model helper skill\n---\nUse the model helper skill."
);
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
	await rm(mentionFixtureDirectory, { force: true, recursive: true });
});

const recorder = createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder)
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
const { sessionId } = await seedCompactionHistory(store, 2);

test("filters a transposed skill query and keeps folder mentions searchable", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(20_000),
			sessionId,
		});
		const activeSetup = rendered.setup;
		setup = activeSetup;
		await rendered.registryReady;
		await act(async () => {
			await getFileMentionOptions();
		});
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
		expect(emptyQueryFrame).not.toContain("skill:model-4o");

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
			await activeSetup.mockInput.typeText("/skill:modelo4");
		});
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("skill:model-4o"),
				{ maxPasses: 200 }
			);
		});
		const skillRowFrame = activeSetup.captureCharFrame();
		expect(skillRowFrame).toContain("skill:model-4o");
		expect(skillRowFrame).toContain("Model helper skill");

		// Tab completes the selected Skill row into its namespaced invocation.
		await act(() => activeSetup.mockInput.pressTab());
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain("/skill:model-4o ");

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
		expect(submittedFrame).toContain("/skill:model-4o focus on auth");
		expect(submittedFrame).toContain("model-4o");

		const folderQuery = `@${mentionFixturePath}/utils`;
		const folderLabel = `${mentionFixturePath}/utils/`;
		const waitForFolderSuggestions = async () => {
			await act(async () => {
				await activeSetup.waitForFrame(
					(frame) => frame.includes(folderLabel) && frame.includes("child.ts"),
					{ maxPasses: 200 }
				);
			});
		};
		await act(async () => {
			await activeSetup.mockInput.typeText(folderQuery);
		});
		await waitForFolderSuggestions();

		await act(() => activeSetup.mockInput.pressTab());
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain(`${folderQuery}/`);
		expect(activeSetup.captureCharFrame()).toContain("child.ts");

		await act(async () => {
			await activeSetup.mockInput.typeText(" ");
		});
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).not.toContain("child.ts");

		await act(() => activeSetup.mockInput.pressKey("BACKSPACE"));
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain("child.ts");

		await act(() => activeSetup.mockInput.pressKey("BACKSPACE"));
		await settleSessionUi(activeSetup);
		await waitForFolderSuggestions();
		await act(() => activeSetup.mockInput.pressEnter());
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain(`${folderQuery}/`);
		expect(activeSetup.captureCharFrame()).toContain("child.ts");

		await act(() => activeSetup.mockInput.pressKey("BACKSPACE"));
		await settleSessionUi(activeSetup);
		await waitForFolderSuggestions();
		const folderRows = activeSetup.captureCharFrame().split("\n");
		const folderRowIndex = folderRows.findIndex((row) =>
			row.includes(folderLabel)
		);
		const folderColumnIndex =
			folderRows[folderRowIndex]?.indexOf(folderLabel) ?? -1;
		if (folderRowIndex < 0 || folderColumnIndex < 0) {
			throw new Error("Folder mention row is not visible for mouse selection");
		}
		await act(async () => {
			await activeSetup.mockMouse.click(
				folderColumnIndex + Math.floor(folderLabel.length / 2),
				folderRowIndex
			);
		});
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain(`${folderQuery}/`);
		expect(activeSetup.captureCharFrame()).toContain("child.ts");

		await act(async () => {
			await activeSetup.mockInput.typeText("empty");
		});
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes(`${mentionFixturePath}/utils/empty/`),
				{ maxPasses: 200 }
			);
		});
		await act(() => activeSetup.mockInput.pressTab());
		await settleSessionUi(activeSetup);
		expect(activeSetup.captureCharFrame()).toContain(
			`@${mentionFixturePath}/utils/empty/`
		);
		expect(activeSetup.captureCharFrame()).toContain("No matching files");
	} finally {
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
