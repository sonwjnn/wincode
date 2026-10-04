import { afterAll, describe, expect, mock, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Host opens the store its capabilities hand it, so this test runs against
 * a real local store of its own: a temporary directory nothing else in the
 * process shares.
 */
const testDirectory = mkdtempSync(join(tmpdir(), "wincode-session-host-"));

import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentTurnEvent,
	createOperationalFailure,
	type SessionRecord,
} from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import type { ChatModelSelection } from "@wincode/ai/models";
import { logger } from "@wincode/utils";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import { buildAgentRegistry } from "@/modules/agents/registry";
import type {
	SessionSubmissionAdmission,
	SessionSubmissionEvent,
} from "@/modules/sessions/agent-session/types";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import type { DelegationTask } from "@/modules/sessions/delegation/types";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostManager,
} from "@/modules/sessions/host/types";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	buildUserSessionRecord,
	projectSessionRecords,
} from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { SessionWriterLock } from "@/modules/sessions/storage/session-writer-lock";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import { toMcpSnapshotId } from "@/shared/identifiers";
import {
	readLoggerRecords,
	withDebugProject,
	withLoggerHome,
} from "../../../utils/test/logger-home";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	compactionId,
	modelId,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";

const recorder = createFakeModelClientRecorder();
// The module mock must be installed before the production Session Host graph
// loads, so the Agent Runtime the Host composes is the fake one. The production
// modules are imported dynamically for that reason alone.
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder)
);

const { createSessionHost } = await import(
	"@/modules/sessions/host/session-host"
);
const { createDatabase } = await import("@/modules/sessions/storage/client");
const { createDrizzleSessionStore } = await import(
	"@/modules/sessions/storage/drizzle-session-store"
);
const { createPermissionService } = await import(
	"@/modules/permissions/permission-service"
);
const { createToolPermissionPolicyState, createToolPermissionRuntime } =
	await import("@/modules/permissions/tool-permission-runtime");
const sessionHostManager = createSessionHostManager();

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const buildId = agentId("build");
const COMPACTION_SUMMARY_TEXT = "the first turn, summarized";
const store = createDrizzleSessionStore(
	createDatabase(join(testDirectory, "sessions.db")).db,
	{
		attachmentRoot: join(testDirectory, "attachments"),
		workspaceRoot: process.cwd(),
	}
);

const message = (
	id: string,
	role: "assistant" | "user",
	text: string
): SessionMessage => ({
	id: sessionMessageId(id),
	parts: [{ text, type: "text" }],
	role,
});

const completedOutcome = (): SessionRecord["outcome"] => ({
	kind: "assistant",
	terminal: {
		finishedAt: 2,
		kind: "completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	},
});

/**
 * Seeds one session whose durable records exercise what opening must project:
 * a completed turn, an interrupted turn, and a compaction whose boundary sits
 * between them.
 */
const seedSession = async (
	prefix: string
): Promise<{
	compaction: CompactionId;
	sessionId: SessionId;
}> => {
	const firstUser = message(`${prefix}-user-1`, "user", "first request");
	const { id: sessionId } = await store.createSession({
		agent: buildId,
		message: firstUser,
		model,
		turnId: agentTurnId(`${prefix}-turn-1`),
	});
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			id: sessionRecordId(`${prefix}-record-1`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-1`),
					parts: [{ text: "first answer", type: "text" }],
					role: "assistant",
				},
			],
			model,
			outcome: completedOutcome(),
			turnId: agentTurnId(`${prefix}-turn-1`),
			version: 1,
		},
		sessionId,
	});
	const secondUser = message(`${prefix}-user-2`, "user", "second request");
	await store.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: buildId,
			message: secondUser,
			model,
			turnId: agentTurnId(`${prefix}-turn-2`),
		}),
		sessionId,
	});
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			id: sessionRecordId(`${prefix}-record-3`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-2`),
					parts: [{ text: "half an answer", type: "text" }],
					role: "assistant",
				},
			],
			model,
			outcome: {
				kind: "assistant",
				terminal: {
					failure: createOperationalFailure({
						code: "interrupted",
						retry: "never",
						source: "runtime",
					}),
					finishedAt: 3,
					kind: "interrupted",
					reason: "user",
				},
			},
			turnId: agentTurnId(`${prefix}-turn-2`),
			version: 1,
		},
		sessionId,
	});
	const compaction = await store.appendCompaction({
		estimatedTokensAfter: 100,
		firstKeptUiMessageId: sessionMessageId(`${prefix}-user-2`),
		sessionId,
		summarizationModel: model,
		summary: {
			coveredMessageIds: [sessionMessageId(`${prefix}-user-1`)],
			formatVersion: 1,
			text: COMPACTION_SUMMARY_TEXT,
		},
		throughMessageUiId: sessionMessageId(`${prefix}-assistant-1`),
		tokensBefore: 900,
		trigger: "threshold",
	} satisfies AppendSessionCompactionInput);
	return {
		compaction: compaction.id,
		sessionId,
	};
};

const compactionModule = (summaryGenerator: SummaryGenerator) =>
	createSessionCompaction({
		estimateTokens: (messages) => messages.length,
		generateId: () => compactionId("entry-compacted"),
		store: {
			appendCompaction: async (input: AppendSessionCompactionInput) => ({
				...input,
				completedAt: new Date("2026-09-01T00:00:00.000Z"),
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
				id: input.id ?? compactionId("entry-compacted"),
				sequence: 1,
			}),
			getLatestCompaction: async () => null,
		},
		summaryGenerator,
	});

/**
 * The capabilities one Host runs against outside React: the workspace config,
 * a connection that authorizes the Model Target, an empty MCP catalog, the
 * built-in Agent registry, the Tool Permission runtime, and the Session
 * Compaction module the Agent Session contract tests fake the same way.
 */
const createCapabilities = (
	sessionStore: SessionStore = store,
	document: ConfigSnapshot["document"] = {},
	manager: SessionHostManager = sessionHostManager
): SessionCapabilities => {
	const workspace = process.cwd();
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document,
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const config = {
		configStore: createConfigStore({
			fs: {
				readFile: async () => {
					throw Object.assign(new Error("Test config is unavailable."), {
						code: "ENOENT",
					});
				},
			},
		}),
		homeRoot: homedir(),
		workspace,
	};
	const toolPermission = createToolPermissionRuntime({
		agent: buildId,
		policyState: createToolPermissionPolicyState(),
		registry,
		service: createPermissionService(),
		workspace,
	});
	return {
		getCompactionModule: () =>
			compactionModule(async () => ({ text: "summary" })),
		getCompactionSettings: async () =>
			fromPartial<ResolvedCompactionSettings>({
				autoAvailable: false,
				enabled: true,
				keepRecentTokens: 1,
				maxMediaAttachments: 4,
				maxMediaBytes: 1024,
				maxMediaTokens: 128,
				modelContextLimit: 200_000,
				overflowRecoveryAvailable: false,
				reserveTokens: 1000,
				thresholdTokens: null,
			}),
		getConfig: () => config,
		getConnections: () => ({
			authorize: async () => ({
				apiKey: "session-host-key",
				kind: "api-key" as const,
			}),
			connect: async () => undefined,
			listProviders: async () => [],
		}),
		getMcp: () => ({
			createSnapshot: async (agent) => ({
				agent,
				id: toMcpSnapshotId("session-host"),
				manifest: [],
				tools: new Map(),
			}),
		}),
		getRegistry: () => registry,
		getStore: () => sessionStore,
		getSessionHostManager: () => manager,
		getToolPermission: () => toolPermission,
	};
};
const createDelayedTerminalStore = (base: SessionStore) => {
	const terminalCommitStarted = Promise.withResolvers<void>();
	const allowTerminalCommit = Promise.withResolvers<void>();
	let blocksTerminalCommit = true;
	const delayed: SessionStore = {
		...base,
		commitSessionRecord: async (input) => {
			if (blocksTerminalCommit && input.record.outcome.kind === "assistant") {
				blocksTerminalCommit = false;
				terminalCommitStarted.resolve();
				await allowTerminalCommit.promise;
			}
			await base.commitSessionRecord(input);
		},
	};
	return { allowTerminalCommit, delayed, terminalCommitStarted };
};

const resolvedAgentOf = (
	capabilities: SessionCapabilities
): ResolvedCodingAgent => {
	const agent = capabilities
		.getRegistry()
		?.selectableAgents.find(({ id }) => id === buildId);
	if (!agent) {
		throw new Error("The build Agent is missing from the registry.");
	}
	return fromPartial<ResolvedCodingAgent>({ ...agent });
};

const sendInput = (
	capabilities: SessionCapabilities,
	userText = "third request"
): SessionSendInput => ({
	agent: buildId,
	composition: { files: [], text: userText },
	model,
	resolvedAgent: resolvedAgentOf(capabilities),
	sessionModel: model,
	userText,
});

const textOf = (parts: SessionMessage["parts"]): string =>
	parts.map((part) => (part.type === "text" ? part.text : "")).join("");

afterAll(async () => {
	await sessionHostManager.shutdownAll();
	rmSync(testDirectory, { force: true, recursive: true });
});

describe("Session Host opening", () => {
	test("opens the transcript, context, compactions, and Session Selection a consumer reads", async () => {
		const seeded = await seedSession("open");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});

		const snapshot = host.getSnapshot();

		expect(snapshot.transcript.map(({ id }) => id)).toEqual([
			sessionMessageId("open-user-1"),
			sessionMessageId("open-assistant-1"),
			sessionMessageId("open-user-2"),
			sessionMessageId("open-assistant-2"),
		]);
		// An interrupted turn keeps its Session Record and reads as interrupted.
		expect(snapshot.transcript[3]?.metadata?.terminalOutcome).toBe(
			"interrupted"
		);
		// The Session Context is rebuilt around the latest compaction: its summary
		// stands in for covered messages, and only primary records remain.
		expect(snapshot.context.map(({ id }) => id)).toEqual([
			compactionSummaryMessageId(seeded.compaction),
			sessionMessageId("open-user-2"),
			sessionMessageId("open-assistant-2"),
		]);
		expect(textOf(snapshot.context[0]?.parts ?? [])).toContain(
			COMPACTION_SUMMARY_TEXT
		);
		expect(snapshot.compactions.map(({ id }) => id)).toEqual([
			seeded.compaction,
		]);
		// The session exposes what its next turn runs with.
		expect(host.getSelection()).toEqual({
			agent: buildId,
			model,
			persistedAgent: buildId,
			effort: undefined,
			reasoningMode: undefined,
		});

		await host.shutdown();
	});
	test("refuses a second Host while the first Host owns the Session", async () => {
		const seeded = await seedSession("contention");
		const secondDatabase = createDatabase(join(testDirectory, "sessions.db"));
		const secondStore = createDrizzleSessionStore(secondDatabase.db, {
			attachmentRoot: join(testDirectory, "second-attachments"),
			snapshotRoot: join(testDirectory, "second-snapshots"),
			workspaceRoot: process.cwd(),
		});
		const firstHost = await createSessionHost({
			capabilities: createCapabilities(),
			sessionId: seeded.sessionId,
		});

		try {
			await expect(
				createSessionHost({
					capabilities: createCapabilities(secondStore),
					sessionId: seeded.sessionId,
				})
			).rejects.toMatchObject({ code: "session_in_use" });
		} finally {
			await firstHost.shutdown();
			secondDatabase.sqlite.close();
		}
	});
});

describe("Session Host lifetime", () => {
	test("runs a send command, reports its events in order, and refuses commands after shutdown", async () => {
		const seeded = await seedSession("send");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const events: AgentTurnEvent[] = [];
		host.onEvent((event) => events.push(event));
		let snapshotChanges = 0;
		host.subscribe(() => {
			snapshotChanges += 1;
		});

		const outcome = await host.agentSession.send(sendInput(capabilities));

		expect(outcome).toEqual({ rejected: false });
		expect(snapshotChanges).toBeGreaterThan(0);
		// The Agent Turn Events the Agent Session emits reach a consumer in order,
		// terminal event included.
		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"text-delta",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const transcript = host.getSnapshot().transcript;
		expect(transcript.map(({ id }) => id)).toEqual(
			projectSessionRecords(
				await store.listSessionRecords(seeded.sessionId)
			).map(({ id }) => id)
		);
		const sentUserIndex = transcript.findIndex(
			({ parts, role }) => role === "user" && textOf(parts) === "third request"
		);
		const sentAssistantIndex = transcript.findIndex(
			({ parts, role }) =>
				role === "assistant" && textOf(parts) === "E2E chat response"
		);
		expect(sentUserIndex).toBeGreaterThanOrEqual(0);
		expect(sentAssistantIndex).toBeGreaterThan(sentUserIndex);

		await host.shutdown();

		// Shutdown rejects new work without publishing another Snapshot or
		// delivering an event to observers that are tearing down.
		const changesAtShutdown = snapshotChanges;
		const eventsAtShutdown = events.length;
		expect(await host.agentSession.send(sendInput(capabilities))).toMatchObject(
			{
				rejected: true,
			}
		);
		await expect(
			host.agentSession.compact({ model, trigger: "manual" })
		).rejects.toMatchObject({ code: "cancelled" });
		expect(snapshotChanges).toBe(changesAtShutdown);
		expect(events).toHaveLength(eventsAtShutdown);
	});
	test("reorders a streamed assistant message to its durable position after a steer", async () => {
		const { id: openedSessionId } = await store.createSession({
			agent: buildId,
			message: message(
				"live-transcript-order-initial",
				"user",
				"initial request"
			),
			model,
			turnId: agentTurnId("live-transcript-order-initial-turn"),
		});
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: openedSessionId,
		});
		const assistantTextReachedSnapshot = Promise.withResolvers<void>();
		const releaseAssistantStream = Promise.withResolvers<void>();
		const completedTurn = Promise.withResolvers<void>();
		const previousAfterTextDelta = recorder.afterTextDelta;
		let activeTurnId: string | undefined;
		const unsubscribe = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" &&
				event.turnId === activeTurnId
			) {
				completedTurn.resolve();
			}
		});
		recorder.afterTextDelta = async () => {
			assistantTextReachedSnapshot.resolve();
			await releaseAssistantStream.promise;
		};
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});

		try {
			const active = await host.agentSession.prompt(
				inputFor("streamed answer before steer")
			);
			if (active.rejected || active.turnId === undefined) {
				throw new Error("The active Submission did not start.");
			}
			activeTurnId = active.turnId;
			await assistantTextReachedSnapshot.promise;

			const streamedAssistant = host
				.getSnapshot()
				.transcript.findLast(({ role }) => role === "assistant");
			if (streamedAssistant === undefined) {
				throw new Error("The streamed assistant message was not visible.");
			}
			expect(textOf(streamedAssistant.parts)).toBe("E2E chat response");

			const queued = await host.agentSession.prompt(
				inputFor("steer after streamed answer")
			);
			expect(queued).toMatchObject({
				disposition: "queued",
				rejected: false,
			});
			expect(
				host
					.getSnapshot()
					.transcript.some(
						({ parts, role }) =>
							role === "user" && textOf(parts) === "steer after streamed answer"
					)
			).toBe(false);
			const steering = await host.agentSession.steer();
			if (steering.kind !== "steered") {
				throw new Error("The queued Submission was not steered.");
			}

			const liveBeforeAssistantCommit = host.getSnapshot().transcript;
			const streamedAssistantIndex = liveBeforeAssistantCommit.findIndex(
				({ id }) => id === streamedAssistant.id
			);
			const steeringIndex = liveBeforeAssistantCommit.findIndex(
				({ id }) => id === steering.messageId
			);
			expect(streamedAssistantIndex).toBeGreaterThanOrEqual(0);
			expect(steeringIndex).toBeGreaterThan(streamedAssistantIndex);

			releaseAssistantStream.resolve();
			await completedTurn.promise;

			const storedTranscript = projectSessionRecords(
				await store.listSessionRecords(openedSessionId)
			);
			const liveMessageIds = host.getSnapshot().transcript.map(({ id }) => id);
			expect(liveMessageIds).toEqual(storedTranscript.map(({ id }) => id));
			expect(liveMessageIds.indexOf(steering.messageId)).toBeLessThan(
				liveMessageIds.indexOf(streamedAssistant.id)
			);
		} finally {
			releaseAssistantStream.resolve();
			recorder.afterTextDelta = previousAfterTextDelta;
			unsubscribe();
			await host.shutdown();
		}
	});
	test("removes streamed assistant content when its durable record cannot be saved", async () => {
		const { id: openedSessionId } = await store.createSession({
			agent: buildId,
			message: message(
				"failed-stream-order-initial",
				"user",
				"initial request"
			),
			model,
			turnId: agentTurnId("failed-stream-order-initial-turn"),
		});
		const failingStore: SessionStore = {
			...store,
			commitSessionRecord: async (input) => {
				if (input.record.outcome.kind === "assistant") {
					throw new Error("The assistant record could not be saved.");
				}
				await store.commitSessionRecord(input);
			},
		};
		const capabilities = createCapabilities(failingStore);
		const host = await createSessionHost({
			capabilities,
			sessionId: openedSessionId,
		});
		const assistantTextReachedSnapshot = Promise.withResolvers<void>();
		const releaseAssistantStream = Promise.withResolvers<void>();
		const errorPublished = Promise.withResolvers<void>();
		const previousAfterTextDelta = recorder.afterTextDelta;
		const unsubscribe = host.subscribe(() => {
			if (host.getSnapshot().error !== null) {
				errorPublished.resolve();
			}
		});
		recorder.afterTextDelta = async () => {
			assistantTextReachedSnapshot.resolve();
			await releaseAssistantStream.promise;
		};

		try {
			const admission = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "answer whose record fails" },
				userText: "answer whose record fails",
			});
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			await assistantTextReachedSnapshot.promise;
			expect(
				host
					.getSnapshot()
					.transcript.some(
						({ parts, role }) =>
							role === "assistant" &&
							textOf(parts).includes("E2E chat response")
					)
			).toBe(true);

			releaseAssistantStream.resolve();
			await errorPublished.promise;
			const snapshot = host.getSnapshot();
			expect(snapshot.error?.message).toBe(
				"The Agent Turn outcome could not be persisted."
			);
			expect(
				snapshot.transcript.some(
					({ parts, role }) =>
						role === "assistant" && textOf(parts).includes("E2E chat response")
				)
			).toBe(false);
		} finally {
			releaseAssistantStream.resolve();
			recorder.afterTextDelta = previousAfterTextDelta;
			unsubscribe();
			await host.shutdown();
		}
	});
	test("commits each queue-head steer before acknowledging and delivers four user messages FIFO", async () => {
		const seeded = await seedSession("durable-steer");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const queuedTexts = [
			"steer correction one",
			"steer correction two",
			"steer correction three",
			"steer correction four",
		];
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const deliveredRequest = Promise.withResolvers<string[]>();
		const completedTurn = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeStep;
		let heldActiveStep = false;
		let activeTurnId: string | undefined;
		const submissionEvents: SessionSubmissionEvent[] = [];
		const unsubscribeSubmission = host.agentSession.onSubmissionEvent(
			(event) => {
				submissionEvents.push(event);
			}
		);
		const unsubscribe = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" &&
				event.turnId === activeTurnId
			) {
				completedTurn.resolve();
			}
		});
		recorder.beforeStep = async ({ messages }) => {
			const userTexts = messages.flatMap(({ content, role }) =>
				role === "user"
					? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: []
			);
			if (!heldActiveStep && userTexts.includes("durable active turn")) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
				return;
			}
			if (queuedTexts.every((text) => userTexts.includes(text))) {
				deliveredRequest.resolve(
					userTexts.filter((text) => queuedTexts.includes(text))
				);
			}
		};
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});

		try {
			const active = await host.agentSession.prompt(
				inputFor("durable active turn")
			);
			if (active.rejected || active.turnId === undefined) {
				throw new Error("The active Submission did not start.");
			}
			activeTurnId = active.turnId;
			await activeStepStarted.promise;

			const admissions: Array<{
				admission: Extract<
					SessionSubmissionAdmission,
					{ readonly rejected: false }
				>;
				userText: string;
			}> = [];
			for (const userText of queuedTexts) {
				const admission = await host.agentSession.prompt(inputFor(userText));
				if (admission.rejected) {
					throw new Error(admission.reason);
				}
				admissions.push({ admission, userText });
			}
			expect(
				host
					.getSnapshot()
					.transcript.some(({ id }) =>
						admissions.some(({ admission }) => admission.messageId === id)
					)
			).toBe(false);

			for (const { admission, userText } of admissions) {
				const outcome = await host.agentSession.steer();
				if (outcome.kind !== "steered") {
					throw new Error("The queued Submission was not steered.");
				}
				expect(outcome).toMatchObject({
					kind: "steered",
					messageId: admission.messageId,
					submissionId: admission.submissionId,
					turnId: active.turnId,
				});
				const message = host
					.getSnapshot()
					.transcript.find(({ id }) => id === admission.messageId);
				if (message === undefined) {
					throw new Error(
						"The committed Submission was not in the transcript."
					);
				}
				expect(textOf(message.parts)).toBe(userText);
				const matchingRecords = (
					await store.listSessionRecords(seeded.sessionId)
				).filter((record) =>
					record.messages.some(({ id }) => id === admission.messageId)
				);
				expect(matchingRecords).toHaveLength(1);
				expect(matchingRecords[0]?.outcome.kind).toBe("user");
				expect(matchingRecords[0]?.messages[0]?.id).toBe(admission.messageId);
				expect(matchingRecords[0]?.messages[0]?.metadata?.submissionId).toBe(
					admission.submissionId
				);
				expect(
					matchingRecords[0]?.messages[0]?.metadata?.submissionStatus
				).toBe("pending");
				expect(
					await host.agentSession.recallWaitingMessages([
						admission.submissionId,
					])
				).toEqual([]);
			}

			const transcriptBeforeEmptySteer = host.getSnapshot().transcript;
			const recordsBeforeEmptySteer = await store.listSessionRecords(
				seeded.sessionId
			);
			expect(await host.agentSession.steer()).toEqual({ kind: "empty" });
			expect(host.getSnapshot().transcript).toEqual(transcriptBeforeEmptySteer);
			expect(await store.listSessionRecords(seeded.sessionId)).toEqual(
				recordsBeforeEmptySteer
			);

			releaseActiveStep.resolve();
			expect(await deliveredRequest.promise).toEqual(queuedTexts);
			await completedTurn.promise;
			const completedRecords = await store.listSessionRecords(seeded.sessionId);
			for (const { admission } of admissions) {
				const record = completedRecords.find((candidate) =>
					candidate.messages.some(({ id }) => id === admission.messageId)
				);
				expect(record?.messages[0]?.metadata?.submissionStatus).toBe(
					"processed"
				);
				expect(
					submissionEvents
						.filter((event) => event.messageId === admission.messageId)
						.map(({ kind }) => kind)
				).toEqual(["steered", "delivered", "processed"]);
			}
			expect(host.getSnapshot().steeringMessages).toEqual([]);
		} finally {
			releaseActiveStep.resolve();
			recorder.beforeStep = previousBeforeStep;
			unsubscribe();
			unsubscribeSubmission();
			await host.shutdown();
		}
	});
	test("reconciles an unconfirmed processing submission as a retry blocker after restart", async () => {
		const seeded = await seedSession("steer-restart");
		const capabilities = createCapabilities();
		let host: SessionHost = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeStep;
		let heldActiveStep = false;
		recorder.beforeStep = async ({ messages }) => {
			const hasActivePrompt = messages.some(
				({ content, role }) =>
					role === "user" &&
					content.some(
						(part) =>
							part.type === "text" && part.text === "restart active turn"
					)
			);
			if (!heldActiveStep && hasActivePrompt) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
			}
		};
		try {
			const active = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "restart active turn" },
				userText: "restart active turn",
			});
			if (active.rejected) {
				throw new Error(active.reason);
			}
			await activeStepStarted.promise;
			const queued = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "accepted before restart" },
				userText: "accepted before restart",
			});
			if (queued.rejected) {
				throw new Error(queued.reason);
			}
			const steered = await host.agentSession.steer();
			if (steered.kind !== "steered") {
				throw new Error("The queued Submission was not committed.");
			}
			const record = (await store.listSessionRecords(seeded.sessionId)).find(
				(candidate) =>
					candidate.messages.some(({ id }) => id === steered.messageId)
			);
			if (record === undefined) {
				throw new Error("The committed Submission Record is unavailable.");
			}
			await store.updateSessionSubmission({
				messageId: steered.messageId,
				recordId: record.id,
				sessionId: seeded.sessionId,
				status: "processing",
				submissionId: steered.submissionId,
			});
			host.agentSession.cancel();
			releaseActiveStep.resolve();
			await host.shutdown();
			const callsBeforeReopen = recorder.requests.length;
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});

			const snapshot = host.getSnapshot();
			expect(snapshot.steeringMessages).toMatchObject([
				{
					message: {
						id: steered.messageId,
						metadata: {
							submissionFailure:
								"Session closed before provider processing could be confirmed; deliberate retry required.",
							submissionStatus: "failed",
						},
					},
					status: "failed",
				},
			]);
			expect(snapshot.context.some(({ id }) => id === steered.messageId)).toBe(
				false
			);
			expect(host.agentSession.continue()).toMatchObject({
				kind: "rejected",
			});
			expect(recorder.requests).toHaveLength(callsBeforeReopen);
			const recoveredRecord = (
				await store.listSessionRecords(seeded.sessionId)
			).find((candidate) =>
				candidate.messages.some(({ id }) => id === steered.messageId)
			);
			expect(recoveredRecord?.messages[0]?.metadata?.submissionStatus).toBe(
				"failed"
			);
		} finally {
			releaseActiveStep.resolve();
			recorder.beforeStep = previousBeforeStep;
			await host.shutdown();
		}
	});

	test("resumes an unread durable Submission once after restart", async () => {
		const seeded = await seedSession("steer-unread-restart");
		const capabilities = createCapabilities();
		let host: SessionHost = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const resumedStepStarted = Promise.withResolvers<void>();
		const releaseResumedStep = Promise.withResolvers<void>();
		const processed = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeStep;
		let heldActiveStep = false;
		const resumedRequests: string[][] = [];
		const submissionEvents: SessionSubmissionEvent[] = [];
		let unsubscribeResumed: () => void = () => undefined;
		const unsubscribeInitial = host.agentSession.onSubmissionEvent((event) => {
			submissionEvents.push(event);
		});
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});
		recorder.beforeStep = async ({ messages }) => {
			const userTexts = messages.flatMap(({ content, role }) =>
				role === "user"
					? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: []
			);
			if (!heldActiveStep && userTexts.includes("restart pending active")) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
				return;
			}
			if (userTexts.includes("accepted before restart")) {
				resumedRequests.push(
					userTexts.filter((text) => text === "accepted before restart")
				);
				resumedStepStarted.resolve();
				await releaseResumedStep.promise;
			}
		};

		try {
			const active = await host.agentSession.prompt(
				inputFor("restart pending active")
			);
			if (active.rejected) {
				throw new Error(active.reason);
			}
			await activeStepStarted.promise;
			const admission = await host.agentSession.prompt(
				inputFor("accepted before restart")
			);
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			const steered = await host.agentSession.steer();
			if (steered.kind !== "steered") {
				throw new Error("The queued Submission was not committed.");
			}

			host.agentSession.cancel();
			releaseActiveStep.resolve();
			await host.shutdown();
			const interruptedRecord = (
				await store.listSessionRecords(seeded.sessionId)
			).find((record) =>
				record.messages.some(({ id }) => id === steered.messageId)
			);
			expect(interruptedRecord?.messages[0]?.metadata?.submissionStatus).toBe(
				"pending"
			);

			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			unsubscribeResumed = host.agentSession.onSubmissionEvent((event) => {
				submissionEvents.push(event);
				if (
					event.kind === "processed" &&
					event.submissionId === steered.submissionId
				) {
					processed.resolve();
				}
			});
			await resumedStepStarted.promise;
			releaseResumedStep.resolve();
			await processed.promise;

			expect(resumedRequests).toEqual([["accepted before restart"]]);
			const matchingRecords = (
				await store.listSessionRecords(seeded.sessionId)
			).filter((record) =>
				record.messages.some(({ id }) => id === steered.messageId)
			);
			expect(matchingRecords).toHaveLength(1);
			expect(matchingRecords[0]?.messages[0]?.metadata?.submissionStatus).toBe(
				"processed"
			);
			expect(
				host
					.getSnapshot()
					.transcript.filter(({ id }) => id === steered.messageId)
			).toHaveLength(1);
			expect(
				submissionEvents
					.filter(({ submissionId }) => submissionId === steered.submissionId)
					.map(({ kind }) => kind)
			).toEqual(["steered", "started", "processed"]);
		} finally {
			releaseActiveStep.resolve();
			releaseResumedStep.resolve();
			recorder.beforeStep = previousBeforeStep;
			unsubscribeInitial();
			unsubscribeResumed();
			await host.shutdown();
		}
	});

	test("debug diagnostics mark host and turn lifecycle without session content", async () => {
		const seeded = await seedSession("debug-lifecycle");
		const capabilities = createCapabilities();
		await withLoggerHome(async () => {
			await withDebugProject(testDirectory, async () => {
				const host = await createSessionHost({
					capabilities,
					sessionId: seeded.sessionId,
				});
				try {
					expect(await host.agentSession.send(sendInput(capabilities))).toEqual(
						{ rejected: false }
					);
				} finally {
					await host.shutdown();
				}

				await logger.flush();
				const records = await readLoggerRecords(testDirectory);
				const debugRecords = records.filter(({ level }) => level === "debug");
				for (const phase of ["opened", "shutdown", "shutdown-completed"]) {
					expect(debugRecords).toContainEqual(
						expect.objectContaining({
							context: expect.objectContaining({
								operation: "session-host",
								phase,
							}),
						})
					);
				}
				for (const phase of ["started", "completed"]) {
					expect(debugRecords).toContainEqual(
						expect.objectContaining({
							context: expect.objectContaining({
								operation: "session.turn",
								phase,
								turnId: expect.any(String),
							}),
						})
					);
				}
				expect(JSON.stringify(debugRecords)).not.toContain("third request");
			});
		});
	});

	test("refuses a competing Session Writer until its delayed checkpoint settles", async () => {
		const seeded = await seedSession("shutdown-quiescence");
		const delayed = createDelayedTerminalStore(store);
		const capabilities = createCapabilities(delayed.delayed);
		const competingDatabase = createDatabase(
			join(testDirectory, "sessions.db")
		);
		const competingStore = createDrizzleSessionStore(competingDatabase.db, {
			attachmentRoot: join(testDirectory, "competing-attachments"),
			workspaceRoot: process.cwd(),
		});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		let competingWriter: SessionWriterLock | undefined;

		try {
			const send = host.agentSession.send(sendInput(capabilities));
			await delayed.terminalCommitStarted.promise;
			// Advance any shutdown deadline deterministically before checking ownership.
			vi.useFakeTimers();
			let shutdown: Promise<void> | undefined;
			let shutdownTimers = 0;
			try {
				shutdown = host.shutdown();
				shutdownTimers = vi.getTimerCount();
				vi.advanceTimersByTime(60_000);
			} finally {
				vi.useRealTimers();
			}
			if (shutdownTimers > 0 && shutdown !== undefined) {
				await shutdown;
			}
			expect(host.getSnapshot().turnActive).toBe(true);
			await expect(
				competingStore.acquireSessionWriter(seeded.sessionId)
			).rejects.toMatchObject({ code: "session_in_use" });
			delayed.allowTerminalCommit.resolve();
			await shutdown;
			await send;
			const finalRecord = (await store.listSessionRecords(seeded.sessionId)).at(
				-1
			);
			expect(finalRecord?.outcome).toMatchObject({
				kind: "assistant",
				terminal: { kind: "completed" },
			});
			competingWriter = await competingStore.acquireSessionWriter(
				seeded.sessionId
			);
		} finally {
			delayed.allowTerminalCommit.resolve();
			await host.shutdown();
			await competingWriter?.release();
			competingDatabase.sqlite.close();
		}
	}, 15_000);

	test("waits for same-process Host shutdown before remounting", async () => {
		const seeded = await seedSession("shutdown-remount");
		const delayed = createDelayedTerminalStore(store);
		const host = await createSessionHost({
			capabilities: createCapabilities(delayed.delayed),
			sessionId: seeded.sessionId,
		});
		const send = host.agentSession.send(
			sendInput(createCapabilities(delayed.delayed))
		);
		await delayed.terminalCommitStarted.promise;
		const shutdown = host.shutdown();
		const remount = createSessionHost({
			capabilities: createCapabilities(),
			sessionId: seeded.sessionId,
		});
		const probe = Promise.withResolvers<"probe">();
		queueMicrotask(() => probe.resolve("probe"));
		expect(
			await Promise.race([
				remount.then(() => "remounted" as const),
				probe.promise,
			])
		).toBe("probe");

		delayed.allowTerminalCommit.resolve();
		await shutdown;
		await send;
		const remountedHost = await remount;
		await remountedHost.shutdown();
	});

	test("logs prompt persistence failures without prompt or exception content", async () => {
		await withLoggerHome(async (home) => {
			const seeded = await seedSession("prompt-persistence");
			const turnId = agentTurnId("prompt-persistence-turn");
			const failureMessage = "private database detail";
			const failingStore: SessionStore = {
				...store,
				commitSessionRecord: async () => {
					throw Object.assign(new Error(failureMessage), { code: "EIO" });
				},
			};
			const capabilities = createCapabilities(failingStore);
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});

			try {
				expect(
					await host.agentSession.send({ ...sendInput(capabilities), turnId })
				).toMatchObject({ rejected: true });
			} finally {
				await host.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const persistenceRecords = records.filter(
				({ message }) => message === "Session prompt persistence failed"
			);
			expect(persistenceRecords).toHaveLength(1);
			expect(persistenceRecords[0]).toMatchObject({
				context: {
					errorCode: "EIO",
					errorType: "Error",
					operation: "session.prompt",
					phase: "persistence",
					turnId,
				},
				level: "error",
			});
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				failureMessage
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				"third request"
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				seeded.sessionId
			);
		});
	});
	test("records background compaction failures without failing the completed turn", async () => {
		const seeded = await seedSession("background-compaction");
		const modelRequestsBeforeTurn = recorder.requests.length;
		const summaryStarted = Promise.withResolvers<void>();
		const allowSummaryFailure = Promise.withResolvers<void>();
		const compactionFailureObserved = Promise.withResolvers<void>();
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionModule: () =>
				compactionModule(async () => {
					summaryStarted.resolve();
					await allowSummaryFailure.promise;
					throw Object.assign(new Error("private summary detail"), {
						code: "SUMMARY_FAILED",
					});
				}),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: recorder.requests.length > modelRequestsBeforeTurn,
					enabled: true,
					thresholdTokens: 1,
				}),
		};
		await withLoggerHome(async (home) => {
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			const unsubscribe = host.subscribe(() => {
				if (host.getSnapshot().compactionError !== null) {
					compactionFailureObserved.resolve();
				}
			});
			try {
				expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
					rejected: false,
				});
				await summaryStarted.promise;
				allowSummaryFailure.resolve();
				await compactionFailureObserved.promise;
			} finally {
				allowSummaryFailure.resolve();
				unsubscribe();
				await host.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const compactionRecords = records.filter(
				({ context }) =>
					context?.operation === "session.compaction" &&
					context?.trigger === "threshold"
			);
			expect(compactionRecords).toHaveLength(1);
			expect(compactionRecords[0]).toMatchObject({
				context: {
					errorCode: "summary-failed",
					errorType: "SessionCompactionError",
					phase: "failed",
					trigger: "threshold",
					turnId: expect.any(String),
				},
				level: "warn",
			});
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"private summary detail"
			);
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"third request"
			);
		});
	});
	test("does not warn for shutdown-cancelled background compaction", async () => {
		const seeded = await seedSession("cancelled-background-compaction");
		const modelRequestsBeforeTurn = recorder.requests.length;
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionModule: () =>
				compactionModule(async () => {
					throw Object.assign(new Error("private summary detail"), {
						code: "SUMMARY_FAILED",
					});
				}),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: recorder.requests.length > modelRequestsBeforeTurn,
					enabled: true,
					thresholdTokens: 1,
				}),
		};
		await withLoggerHome(async (home) => {
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
				rejected: false,
			});
			await host.shutdown();

			await logger.flush();
			const records = await readLoggerRecords(home).catch(() => []);
			expect(
				records.filter(
					({ context }) =>
						context?.operation === "session.compaction" &&
						context?.trigger === "threshold"
				)
			).toEqual([]);
		});
	});

	test("releases a completed idle Session writer after its last view", async () => {
		const seeded = await seedSession("idle-view-release");
		const manager = createSessionHostManager();
		const capabilities = createCapabilities(store, {}, manager);
		try {
			const host = await manager.openHost({
				capabilities,
				sessionId: seeded.sessionId,
				view: true,
			});
			await host.agentSession.send(
				sendInput(capabilities, "complete before release")
			);
			await manager.releaseView(seeded.sessionId);
			const writer = await store.acquireSessionWriter(seeded.sessionId);
			await writer.release();
		} finally {
			await manager.shutdownAll();
		}
	});
});
test("keeps delegated Sessions live across navigation and consumes one durable report on explicit continuation", async () => {
	const manager = createSessionHostManager();
	let reopenedManager: SessionHostManager | undefined;
	const parentDelegationPrompt = "Delegate an independent inspection to scout.";
	const childInitialPrompt = "Inspect the repository state.";
	const childSteeringPrompt = "Focus on the session host lifecycle.";
	const childReportPrompt = "Submit the final report.";
	const childMixedPrompt =
		"Submit a report only if spawning another child is refused.";
	const delegationCallId = toolCallId("durable-delegation-call");
	const childInitialStarted = Promise.withResolvers<void>();
	const releaseChildInitial = Promise.withResolvers<void>();
	const parentResultStarted = Promise.withResolvers<void>();
	const releaseParentResult = Promise.withResolvers<void>();
	const parentInterrupted = Promise.withResolvers<void>();
	const taskCreated = Promise.withResolvers<DelegationTask>();
	const taskAwaitingReport = Promise.withResolvers<DelegationTask>();
	const taskSucceeded = Promise.withResolvers<DelegationTask>();
	const parentContinuationRequested = Promise.withResolvers<void>();
	const mixedBatchCompleted = Promise.withResolvers<void>();
	const parentReportPublished = Promise.withResolvers<void>();
	const parentContinuationCompleted = Promise.withResolvers<void>();
	const configDocument = {
		agents: {
			scout: {
				description: "Inspect and report findings.",
				role: "subagent",
			},
		},
	};
	const capabilities = createCapabilities(store, configDocument, manager);
	const { id: parentSessionId } = await store.createSession({
		agent: buildId,
		message: message("durable-delegation-parent-seed", "user", "Start here."),
		model,
		turnId: agentTurnId("durable-delegation-parent-seed-turn"),
	});
	const parent = await manager.openHost({
		capabilities,
		sessionId: parentSessionId,
		view: true,
	});
	const priorStepScript = recorder.stepScript;
	const parentReportPrompts: string[] = [];
	let unsubscribeChild: (() => void) | undefined;
	recorder.stepScript = async function* (
		request: ModelStepRequest,
		fakeRecorder
	): AsyncGenerator<ModelStreamPart> {
		fakeRecorder.requests.push({
			kind: "chat",
			messages: request.messages.map(({ content, role }) => ({
				role,
				text: content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\\n"),
			})),
		});
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\\n") ?? "";
		const hasDelegationResult = request.messages.some(
			({ role }) => role === "tool"
		);
		if (latestUserText.includes("Durable report for delegated Task")) {
			parentReportPrompts.push(latestUserText);
			parentContinuationRequested.resolve();
			yield {
				delta: "Parent incorporated the durable report.",
				type: "text-delta",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === childMixedPrompt) {
			const hasToolResults = request.messages.some(
				({ role }) => role === "tool"
			);
			if (hasToolResults) {
				yield { delta: "The mixed batch was refused.", type: "text-delta" };
			} else {
				yield {
					input: {
						details: "This report must not be committed.",
						summary: "This report must be refused.",
					},
					toolCallId: toolCallId("mixed-submit-result-call"),
					toolName: "submit_result",
					type: "tool-call",
				};
				yield {
					input: {
						agent: "scout",
						prompt: "This child must never be spawned.",
					},
					toolCallId: toolCallId("mixed-delegation-call"),
					toolName: "delegate",
					type: "tool-call",
				};
			}
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === childReportPrompt) {
			yield {
				input: {
					details: "The child Session confirmed its findings.",
					summary: "The delegated inspection is complete.",
				},
				toolCallId: toolCallId("durable-submit-result-call"),
				toolName: "submit_result",
				type: "tool-call",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === childSteeringPrompt) {
			yield {
				delta: "The child followed the steering message.",
				type: "text-delta",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === childInitialPrompt) {
			yield { delta: "Initial child investigation.", type: "text-delta" };
			childInitialStarted.resolve();
			await releaseChildInitial.promise;
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (hasDelegationResult) {
			const signal = request.signal;
			if (signal === undefined) {
				throw new Error("The parent model request has no cancellation signal.");
			}
			parentResultStarted.resolve();
			await releaseParentResult.promise;
			signal.throwIfAborted();
			yield { delta: "Parent task started.", type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === parentDelegationPrompt) {
			yield {
				input: { agent: "scout", prompt: childInitialPrompt },
				toolCallId: delegationCallId,
				toolName: "delegate",
				type: "tool-call",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		throw new Error(
			`Unexpected model prompt in delegation journey: ${latestUserText}`
		);
	};
	const unsubscribeManager = manager.onEvent((event) => {
		if (
			event.type !== "delegation-task" ||
			event.task.parentSessionId !== parentSessionId
		) {
			return;
		}
		if (event.task.status === "active") {
			taskCreated.resolve(event.task);
		} else if (event.task.status === "awaiting_report") {
			taskAwaitingReport.resolve(event.task);
		} else if (event.task.status === "succeeded") {
			taskSucceeded.resolve(event.task);
		}
	});
	const unsubscribeParent = parent.onEvent((event) => {
		if (event.type === "agent-turn-interrupted") {
			parentInterrupted.resolve();
		}
		if (
			event.type === "agent-turn-completed" &&
			parentReportPrompts.length > 0
		) {
			parentContinuationCompleted.resolve();
		}
	});
	const unsubscribeParentSnapshot = parent.subscribe(() => {
		if (parent.agentSession.getSnapshot().pendingDelegationReports.length > 0) {
			parentReportPublished.resolve();
		}
	});
	try {
		const parentSend = parent.agentSession.send(
			sendInput(capabilities, parentDelegationPrompt)
		);
		const activeTask = await taskCreated.promise;
		expect(activeTask).toMatchObject({
			parentSessionId,
			parentToolCallId: delegationCallId,
			status: "active",
		});
		expect(activeTask.childSessionId).not.toBe(parentSessionId);
		const child = await manager.openHost({
			capabilities,
			sessionId: activeTask.childSessionId,
			view: true,
		});
		await childInitialStarted.promise;
		await parentResultStarted.promise;
		expect(parent.agentSession.getSnapshot().turnActive).toBe(true);
		expect(await parent.agentSession.interruptAll()).toMatchObject({
			kind: "turn",
		});
		releaseParentResult.resolve();
		await parentInterrupted.promise;
		expect(parent.agentSession.getSnapshot().turnActive).toBe(false);
		expect(child.agentSession.getSnapshot().turnActive).toBe(true);
		expect(await store.getDelegationTask(activeTask.id)).toMatchObject({
			status: "active",
		});
		await parentSend;

		await manager.releaseView(parentSessionId);
		expect(
			await manager.openHost({
				capabilities,
				sessionId: parentSessionId,
				view: true,
			})
		).toBe(parent);
		const queuedPrompt = await child.agentSession.send(
			sendInput(capabilities, childSteeringPrompt)
		);
		expect(queuedPrompt).toMatchObject({ rejected: false });
		expect(await child.agentSession.steer()).toMatchObject({ kind: "steered" });
		releaseChildInitial.resolve();
		await taskAwaitingReport.promise;
		expect(await store.getDelegationTask(activeTask.id)).toMatchObject({
			status: "awaiting_report",
		});

		unsubscribeChild = child.onEvent((event) => {
			if (event.type === "agent-turn-completed") {
				mixedBatchCompleted.resolve();
			}
		});
		await child.agentSession.send(sendInput(capabilities, childMixedPrompt));
		await mixedBatchCompleted.promise;
		expect(await store.getDelegationTask(activeTask.id)).toMatchObject({
			outcome: null,
			status: "awaiting_report",
		});
		expect(await store.listDelegationTasks(parentSessionId)).toHaveLength(1);
		expect(
			await store.listPendingDelegationReports(parentSessionId)
		).toHaveLength(0);
		unsubscribeChild();
		unsubscribeChild = undefined;
		await child.agentSession.send(sendInput(capabilities, childReportPrompt));
		const succeeded = await taskSucceeded.promise;
		expect(succeeded).toMatchObject({
			childSessionId: activeTask.childSessionId,
			status: "succeeded",
		});
		await parentReportPublished.promise;
		expect(
			await store.listPendingDelegationReports(parentSessionId)
		).toHaveLength(1);
		expect(
			parent.agentSession.getSnapshot().pendingDelegationReports
		).toHaveLength(1);
		expect(parentReportPrompts).toEqual([]);

		await manager.releaseView(activeTask.childSessionId);

		expect(parent.agentSession.continue()).toMatchObject({ kind: "resumed" });
		await parentContinuationRequested.promise;
		await parentContinuationCompleted.promise;
		expect(parentReportPrompts).toHaveLength(1);
		expect(
			parent.agentSession.getSnapshot().pendingDelegationReports
		).toHaveLength(0);
		const parentMessages = parent.getSnapshot().transcript;
		expect(
			parentMessages.some(({ parts }) =>
				textOf(parts).includes("Parent incorporated the durable report.")
			)
		).toBe(true);
		expect(
			parentMessages.some(({ parts }) =>
				textOf(parts).includes("Initial child investigation.")
			)
		).toBe(false);
		expect(
			await store.listPendingDelegationReports(parentSessionId)
		).toHaveLength(0);

		await manager.shutdownAll();
		reopenedManager = createSessionHostManager();
		const reopenedCapabilities = createCapabilities(
			store,
			configDocument,
			reopenedManager
		);
		const reopenedChild = await reopenedManager.openHost({
			capabilities: reopenedCapabilities,
			sessionId: activeTask.childSessionId,
			view: true,
		});
		expect(reopenedChild).not.toBe(child);
		expect(
			reopenedChild
				.getSnapshot()
				.transcript.some(({ parts }) =>
					textOf(parts).includes("The child followed the steering message.")
				)
		).toBe(true);
		expect(reopenedChild.getSnapshot().turnActive).toBe(false);
		await reopenedManager.releaseView(activeTask.childSessionId);
		const reopenedParent = await reopenedManager.openHost({
			capabilities: reopenedCapabilities,
			sessionId: parentSessionId,
			view: true,
		});
		expect(
			reopenedParent.agentSession.getSnapshot().pendingDelegationReports
		).toHaveLength(0);
		expect(
			reopenedParent
				.getSnapshot()
				.transcript.some(({ parts }) =>
					textOf(parts).includes("Parent incorporated the durable report.")
				)
		).toBe(true);
		expect(parentReportPrompts).toHaveLength(1);
		await reopenedManager.shutdownAll();
	} finally {
		unsubscribeChild?.();
		releaseChildInitial.resolve();
		releaseParentResult.resolve();
		unsubscribeManager();
		await reopenedManager?.shutdownAll();
		unsubscribeParent();
		unsubscribeParentSnapshot();
		recorder.stepScript = priorStepScript;
		await manager.shutdownAll();
	}
}, 15_000);
test("graceful shutdown records cancellation and retains an active child Session", async () => {
	const manager = createSessionHostManager();
	const parentPrompt =
		"Delegate an inspection that will be interrupted by shutdown.";
	const childPrompt = "Keep inspecting until the application shuts down.";
	const childRequestStarted = Promise.withResolvers<void>();
	const priorStepScript = recorder.stepScript;
	const configDocument = {
		agents: {
			scout: {
				description: "Inspect and report findings.",
				role: "subagent",
			},
		},
	};
	const capabilities = createCapabilities(store, configDocument, manager);
	const { id: parentSessionId } = await store.createSession({
		agent: buildId,
		message: message("shutdown-delegation-parent-seed", "user", "Start here."),
		model,
		turnId: agentTurnId("shutdown-delegation-parent-turn"),
	});
	recorder.stepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		if (latestUserText === childPrompt) {
			childRequestStarted.resolve();
			const signal = request.signal;
			if (signal === undefined) {
				throw new Error("The child model request has no cancellation signal.");
			}
			const aborted = Promise.withResolvers<never>();
			const rejectOnAbort = (): void => aborted.reject(signal.reason);
			signal.addEventListener("abort", rejectOnAbort, { once: true });
			if (signal.aborted) {
				rejectOnAbort();
			}
			try {
				await aborted.promise;
			} finally {
				signal.removeEventListener("abort", rejectOnAbort);
			}
			return;
		}
		if (latestUserText !== parentPrompt) {
			throw new Error(
				`Unexpected model prompt during shutdown: ${latestUserText}`
			);
		}
		yield {
			input: { agent: "scout", prompt: childPrompt },
			toolCallId: toolCallId("shutdown-delegation-call"),
			toolName: "delegate",
			type: "tool-call",
		};
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
	};
	try {
		const parent = await manager.openHost({
			capabilities,
			sessionId: parentSessionId,
			view: true,
		});
		await parent.agentSession.send(sendInput(capabilities, parentPrompt));
		await childRequestStarted.promise;
		const task = (await store.listDelegationTasks(parentSessionId))[0];
		if (task === undefined) {
			throw new Error("The running child Task was not durably recorded.");
		}
		expect(task).toMatchObject({ status: "active" });

		await manager.shutdownAll();

		expect(await store.getDelegationTask(task.id)).toMatchObject({
			outcome: { kind: "cancelled" },
			status: "cancelled",
		});
		expect(
			await store.listPendingDelegationReports(parentSessionId)
		).toMatchObject([{ outcome: { kind: "cancelled" }, taskId: task.id }]);
		expect(await store.getSession(task.childSessionId)).not.toBeNull();
	} finally {
		recorder.stepScript = priorStepScript;
		await manager.shutdownAll();
	}
});

test("unclean recovery marks active Delegated Tasks interrupted without replay", async () => {
	const { id: parentSessionId } = await store.createSession({
		agent: buildId,
		message: message("unclean-delegation-parent-seed", "user", "Start here."),
		model,
		turnId: agentTurnId("unclean-delegation-parent-turn"),
	});
	const task = await store.createDelegatedTask({
		agent: buildId,
		message: message(
			"unclean-delegation-child-prompt",
			"user",
			"Inspect without replaying unconfirmed work."
		),
		model,
		parentSessionId,
		parentToolCallId: toolCallId("unclean-delegation-call"),
		parentTurnId: agentTurnId("unclean-delegation-parent-turn"),
		turnId: agentTurnId("unclean-delegation-child-turn"),
	});
	const requestsBeforeOpen = recorder.requests.length;
	await store.recoverUncleanDelegationTasks();

	expect(await store.getDelegationTask(task.id)).toMatchObject({
		outcome: { kind: "interrupted" },
		status: "interrupted",
	});
	expect(
		await store.listPendingDelegationReports(parentSessionId)
	).toMatchObject([{ outcome: { kind: "interrupted" }, taskId: task.id }]);
	expect(await store.getSession(task.childSessionId)).not.toBeNull();

	const manager = createSessionHostManager();
	const capabilities = createCapabilities(store, {}, manager);
	try {
		const reopenedChild = await manager.openHost({
			capabilities,
			sessionId: task.childSessionId,
			view: true,
		});
		expect(reopenedChild.getSnapshot().turnActive).toBe(false);
		expect(recorder.requests.length).toBe(requestsBeforeOpen);
	} finally {
		await manager.shutdownAll();
	}
});

test("preserves active Delegated Tasks while either Session Writer is held", async () => {
	const { id: parentSessionId } = await store.createSession({
		agent: buildId,
		message: message("live-delegation-parent-seed", "user", "Start here."),
		model,
		turnId: agentTurnId("live-delegation-parent-turn"),
	});
	const task = await store.createDelegatedTask({
		agent: buildId,
		message: message(
			"live-delegation-child-prompt",
			"user",
			"Keep this active task reportable."
		),
		model,
		parentSessionId,
		parentToolCallId: toolCallId("live-delegation-call"),
		parentTurnId: agentTurnId("live-delegation-parent-turn"),
		turnId: agentTurnId("live-delegation-child-turn"),
	});
	for (const sessionId of [parentSessionId, task.childSessionId]) {
		const writerLock = await store.acquireSessionWriter(sessionId);
		try {
			await store.recoverUncleanDelegationTasks();

			expect(await store.getDelegationTask(task.id)).toMatchObject({
				outcome: null,
				status: "active",
			});
			expect(await store.listPendingDelegationReports(parentSessionId)).toEqual(
				[]
			);
		} finally {
			await writerLock.release();
		}
	}
});
