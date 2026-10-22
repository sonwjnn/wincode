import { afterAll, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import type {
	ProviderChatEvent,
	ProviderChatRequest,
	ProviderModel,
} from "@wincode/ai";
import {
	getSharedSubagentsTaskStore,
	resolveSubagentsDatabasePath,
} from "@wincode/subagents/plugin";
import { act } from "react";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import { loadPlugins } from "@/modules/plugins/loader";
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { createConfigStore } from "@/shared/config/config-store";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	installFakeProviderRecorder,
} from "@/test/support/e2e-fake-runtime";
import {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	E2E_MODEL,
	renderSession,
	seedCompactionHistory,
	settleSessionUi,
	waitForSessionCondition,
	waitForSessionFrame,
	writeE2EFrame,
} from "@/test/support/e2e-fixture";
import { createEnvironmentRestorer } from "@/test/support/environment";
import { toolCallId } from "../support/identifiers";

const restoreEnvironment = createEnvironmentRestorer([
	"HOME",
	"USERPROFILE",
	"WINCODE_E2E_HOME",
	"WINCODE_E2E_WORKSPACE",
	"WINCODE_LOCAL_DB_PATH",
	"WINCODE_SUBAGENTS_DB_PATH",
]);
const testDirectory = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-delegation-e2e-")
);
const trustDirectory = path.join(testDirectory, ".wincode");
await Bun.write(
	path.join(trustDirectory, "project-trust.json"),
	JSON.stringify({
		decisions: [
			{ directory: await fs.realpath(process.cwd()), decision: "trust" },
		],
		version: 1,
	})
);
const homeDirSpy = spyOn(os, "homedir").mockReturnValue(testDirectory);
process.env.HOME = testDirectory;
process.env.USERPROFILE = testDirectory;
process.env.WINCODE_LOCAL_DB_PATH = path.join(
	testDirectory,
	"conversation.sqlite"
);
process.env.WINCODE_SUBAGENTS_DB_PATH = path.join(
	testDirectory,
	"subagents.sqlite"
);
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;

const recorder = createFakeProviderRecorder();
installFakeProviderRecorder(recorder);
const sessionProviderModel: ProviderModel = {
	capabilities: ["reasoning", "text", "tools"],
	modelId: E2E_MODEL.modelId,
	promptCacheRetentionTiers: ["short"],
	providerId: E2E_MODEL.providerId,
	protocolId: "fake-e2e-provider",
	reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
};
const taskStore = await getSharedSubagentsTaskStore(
	resolveSubagentsDatabasePath(testDirectory, resolveUserDataDir())
);
const composition = createApplicationPluginComposition();
const pluginRuntime = await loadPlugins({
	cliPaths: [],
	distributionPlugins: composition.distributionPlugins,
	config: {
		configStore: createConfigStore({
			homeRoot: testDirectory,
		}),
		cwd: testDirectory,
		homeRoot: testDirectory,
		workspace: testDirectory,
	},
});
setInteractiveRuntimeContext({
	args: [],
	cwd: testDirectory,
	createProviderCollection: () =>
		createFakeProviderCollection(recorder, sessionProviderModel),
	pluginRuntime,
});
const sessionHostManager = getInteractiveSessionHostManager(pluginRuntime);

afterAll(async () => {
	await sessionHostManager.shutdownAll();
	await pluginRuntime.shutdown();
	taskStore.close();
	homeDirSpy.mockRestore();
	mock.restore();
	restoreEnvironment();
	await fs.rm(testDirectory, { force: true, recursive: true });
});

const CHILD_PROMPT = "Inspect the repository state.";
const CHILD_OUTPUT = "Child investigation stays in its own Session.";
const PARENT_OUTPUT = "Parent received a child Task ID.";
const configDocument = `{
	"agents": {
		"scout": { "description": "Inspect and report findings", "role": "subagent" }
	}
}`;

test("projects delegated work as a separate durable Session, not parent transcript output", async () => {
	const store = createE2eStore();
	const { sessionId: parentSessionId } = await seedCompactionHistory(store, 1);
	const priorStepScript = recorder.stepScript;
	const callId = toolCallId("separate-session-delegation");
	recorder.stepScript = async function* (
		request: ProviderChatRequest
	): AsyncGenerator<ProviderChatEvent> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		if (latestUserText === CHILD_PROMPT) {
			yield { delta: CHILD_OUTPUT, type: "text-delta" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
			return;
		}
		if (request.messages.some(({ role }) => role === "tool")) {
			yield { delta: PARENT_OUTPUT, type: "text-delta" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
			return;
		}
		yield {
			input: { agent: "scout", prompt: CHILD_PROMPT },
			toolCallId: callId,
			toolName: "delegate",
			type: "tool-call",
		};
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument,
			pricing: createE2ePricing(200_000),
			sessionId: parentSessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("context detail")
		);
		await act(async () => {
			await setup?.flush();
			await setup?.flush();
		});
		await act(async () => {
			await setup?.mockInput.typeText("delegate the inspection");
			await setup?.flush();
			setup?.mockInput.pressEnter();
		});
		await waitForSessionCondition(async () =>
			taskStore
				.listTasks(parentSessionId)
				.some(
					(task) =>
						task.parentToolCallId === callId &&
						task.status === "awaiting_report"
				)
		).catch((error: unknown) => {
			throw new Error(
				[
					error instanceof Error ? error.message : String(error),
					setup?.captureCharFrame(),
					JSON.stringify(taskStore.listTasks(parentSessionId), null, 2),
				]
					.filter(Boolean)
					.join("\n")
			);
		});
		await waitForSessionFrame(setup, (frame) => frame.includes(PARENT_OUTPUT));
		await settleSessionUi(setup);
		const task = taskStore
			.listTasks(parentSessionId)
			.find((candidate) => candidate.parentToolCallId === callId);
		expect(task).toMatchObject({
			parentSessionId,
			status: "awaiting_report",
		});
		if (task === undefined) {
			throw new Error("The delegated task was not durably recorded.");
		}
		expect(task.childSessionId).not.toBe(parentSessionId);
		const parentFrame = setup.captureCharFrame();
		expect(parentFrame).toContain(PARENT_OUTPUT);
		expect(parentFrame).not.toContain(CHILD_OUTPUT);

		const childRecords = await store.listSessionRecords(task.childSessionId);
		const parentRecords = await store.listSessionRecords(parentSessionId);
		expect(
			childRecords.some(
				(record) =>
					record.outcome.kind === "assistant" &&
					record.messages.some((message) =>
						message.parts.some(
							(part) => part.type === "text" && part.text.includes(CHILD_OUTPUT)
						)
					)
			)
		).toBe(true);
		expect(
			parentRecords.some((record) =>
				record.messages.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text.includes(CHILD_OUTPUT)
					)
				)
			)
		).toBe(false);
	} finally {
		recorder.stepScript = priorStepScript;
		if (setup) {
			await writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
