// The E2E test entrypoint preloads this setup before evaluating this case.

import { afterAll, expect, mock, test } from "bun:test";
import type { createCliRenderer } from "@opentui/core";
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@opentui/core/testing";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import type { DispatchModeRunners } from "@/modules/application/dispatch";
import { dispatch } from "@/modules/application/dispatch";
import type { SessionId } from "@/shared/identifiers";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createE2eStore,
	waitForSessionCondition,
} from "@/test/support/e2e-fixture";
import { runInteractive } from "@/tui/runtime";
import { toolCallId } from "../support/identifiers";
import {
	cleanupTestDirectory,
	recorder,
	restoreEnvironment,
	restoreScrollTo,
	testDirectory,
} from "../support/interactive-cli-delegation-setup";

const waitForFrame = async (
	setup: TestRendererSetup,
	predicate: (frame: string) => boolean
): Promise<void> => {
	const deadline = Date.now() + 5000;
	while (!predicate(setup.captureCharFrame())) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for a TUI frame:\n${setup.captureCharFrame()}`
			);
		}
		await Bun.sleep(10);
	}
};

const CHILD_PROMPT = "Inspect the repository state.";
const CHILD_OUTPUT = "The child result stayed in its own Session.";
const REPORT_SUMMARY = "The child inspection confirmed the repository state.";
const REPORT_DETAILS =
	"The durable child report contains the requested finding.";
const PARENT_START_OUTPUT = "Interactive CLI started the delegated inspection.";
const PARENT_OUTPUT = "Interactive CLI incorporated the durable child report.";
const SUBMISSION = "Delegate an inspection from the interactive CLI.";
const DELEGATION_CALL_ID = toolCallId("interactive-cli-delegation");
const SUBMIT_RESULT_CALL_ID = toolCallId("interactive-cli-submit-result");

recorder.stepScript = async function* (
	request: ModelStepRequest
): AsyncGenerator<ModelStreamPart> {
	const latestUserText =
		request.messages
			.filter(({ role }) => role === "user")
			.at(-1)
			?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n") ?? "";
	if (latestUserText.includes("Durable report for delegated Task")) {
		yield { delta: PARENT_OUTPUT, type: "text-delta" };
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
		return;
	}
	if (latestUserText === CHILD_PROMPT) {
		yield { delta: CHILD_OUTPUT, type: "text-delta" };
		yield {
			input: { details: REPORT_DETAILS, summary: REPORT_SUMMARY },
			toolCallId: SUBMIT_RESULT_CALL_ID,
			toolName: "submit_result",
			type: "tool-call",
		};
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
		return;
	}
	if (request.messages.some(({ role }) => role === "tool")) {
		yield { delta: PARENT_START_OUTPUT, type: "text-delta" };
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
		return;
	}
	yield {
		input: { agent: "scout", prompt: CHILD_PROMPT },
		toolCallId: DELEGATION_CALL_ID,
		toolName: "delegate",
		type: "tool-call",
	};
	yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
};

afterAll(async () => {
	mock.restore();
	restoreScrollTo();
	restoreEnvironment();
	await cleanupTestDirectory();
});

test("default Interactive CLI dispatch incorporates a durable child report offline", async () => {
	const store = createE2eStore();
	const rendererReady = Promise.withResolvers<TestRendererSetup>();
	let setup: TestRendererSetup | undefined;
	let stderr = "";
	const rendererFactory: typeof createCliRenderer = async (options) => {
		const rendered = await createTestRenderer({
			...options,
			height: 40,
			width: 120,
		});
		setup = rendered;
		rendererReady.resolve(rendered);
		return rendered.renderer;
	};
	const runners: DispatchModeRunners = {
		interactive: async (context) => {
			setInteractiveRuntimeContext({ args: context.args, cwd: context.cwd });
			return runInteractive(rendererFactory);
		},
		json: async () => 0,
		print: async () => 0,
		rpc: async () => 0,
	};
	const cliRun = dispatch(
		{
			args: [],
			cwd: testDirectory,
			stderr: { write: (chunk) => (stderr += chunk) },
			stdinIsTTY: true,
			stdout: { write: () => undefined },
		},
		runners
	);

	try {
		setup = await Promise.race([
			rendererReady.promise,
			cliRun.then((exitCode) => {
				throw new Error(
					`Interactive CLI exited before rendering (${exitCode}): ${stderr}`
				);
			}),
		]);
		await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
		await Bun.sleep(500);
		await setup.mockInput.typeText(SUBMISSION);
		setup.mockInput.pressEnter();

		let parentSessionId: SessionId | undefined;
		await waitForSessionCondition(async () => {
			for (const session of await store.listSessions()) {
				const task = (await store.listDelegationTasks(session.id)).find(
					(candidate) => candidate.parentToolCallId === DELEGATION_CALL_ID
				);
				if (task?.status === "succeeded") {
					parentSessionId = session.id;
					return true;
				}
			}
			return false;
		}).catch(async (error: unknown) => {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n${setup?.captureCharFrame()}\n${JSON.stringify(await store.listSessions())}`
			);
		});
		await waitForFrame(setup, (frame) => frame.includes(PARENT_OUTPUT));

		if (parentSessionId === undefined) {
			throw new Error("Interactive CLI did not create a delegated task.");
		}
		const task = (await store.listDelegationTasks(parentSessionId)).find(
			(candidate) => candidate.parentToolCallId === DELEGATION_CALL_ID
		);
		if (task === undefined) {
			throw new Error("The delegated task was not durably recorded.");
		}
		expect(task).toMatchObject({
			outcome: {
				kind: "result",
				report: { details: REPORT_DETAILS, summary: REPORT_SUMMARY },
			},
			parentSessionId,
			status: "succeeded",
		});
		const childRecords = await store.listSessionRecords(task.childSessionId);
		const parentRecords = await store.listSessionRecords(parentSessionId);
		expect(
			childRecords.some((record) =>
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
		const reportRecordIndex = parentRecords.findIndex(
			(record) =>
				record.outcome.kind === "user" &&
				record.messages.some((message) =>
					message.parts.some(
						(part) =>
							part.type === "text" &&
							part.text.includes("Durable report for delegated Task") &&
							part.text.includes(REPORT_SUMMARY)
					)
				)
		);
		const incorporatedReportIndex = parentRecords.findIndex(
			(record) =>
				record.outcome.kind === "assistant" &&
				record.messages.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text.includes(PARENT_OUTPUT)
					)
				)
		);
		expect(reportRecordIndex).toBeGreaterThanOrEqual(0);
		expect(incorporatedReportIndex).toBeGreaterThan(reportRecordIndex);
		expect(
			await store.listPendingDelegationReports(parentSessionId)
		).toHaveLength(0);
		expect(setup.captureCharFrame()).toContain(PARENT_OUTPUT);
		expect(setup.captureCharFrame()).not.toContain(CHILD_OUTPUT);

		setup.renderer.destroy();
		expect(await cliRun).toBe(0);
	} finally {
		if (setup !== undefined) {
			setup.renderer.destroy();
			await Promise.race([cliRun.catch(() => undefined), Bun.sleep(2000)]);
		}
	}
}, 30_000);
