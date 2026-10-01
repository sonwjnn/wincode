import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
	AgentTurnEvent,
	AgentTurnId,
	AgentTurnTerminalEvent,
	OperationalFailure,
	SessionMessageId,
	SessionRecord,
} from "@wincode/agent-core";
import type {
	ChatModelSelection,
	Effort,
	ReasoningMode,
} from "@wincode/ai/models";
import { logger } from "@wincode/runtime-utils";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import {
	attachmentReferenceToFilePart,
	createMemoryAttachmentMetadataRepository,
	createSessionAttachmentStore,
} from "@/modules/sessions/attachments";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import { AgentSessionImpl } from "@/modules/sessions/engine/agent-session";
import type {
	AgentSessionPorts,
	SessionInterruptResult,
	SessionSkillCatalog,
	SessionSteeringAdmission,
	SessionSubmissionEvent,
	SessionTurnRequest,
	SessionWaitingMessage,
} from "@/modules/sessions/engine/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import {
	buildUserSessionRecord,
	projectSessionRecords,
} from "@/modules/sessions/storage/session-record";
import type {
	SessionSendInput,
	SessionSubmissionComposition,
} from "@/modules/sessions/submission-types";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import {
	readLoggerRecords,
	withDebugProject,
	withLoggerHome,
} from "../../../utils/test/logger-home";
import { createHangingSummary } from "../support/hanging-summary";
import {
	agentId,
	agentTurnId,
	attachmentId,
	compactionId,
	modelId,
	queuedSubmissionId,
	sessionId,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

const message = (id: string, text = id): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text, type: "text" }],
		role: "user",
	});

const compactionHistory = (): SessionMessage[] => [
	message("u1", "first request"),
	message("a1", "first answer"),
	message("u2", "current request"),
	message("a2", "current answer"),
];

const createCompactionModule = (summaryGenerator: SummaryGenerator) =>
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

/** The ports one Agent Session test runs against, unless it overrides them. */
const createPorts = ({
	compaction,
	...overrides
}: Partial<AgentSessionPorts> & {
	compaction: AgentSessionPorts["compaction"];
}): AgentSessionPorts => ({
	attachments: {
		externalize: async (messages) => [...messages],
		hydrate: async ({ messages }) => [...messages],
		release: () => undefined,
		retain: () => undefined,
	},
	resolveSubmission: (input) => input,
	compaction,
	resolveCompactionSettings: async () =>
		fromPartial<ResolvedCompactionSettings>({
			autoAvailable: false,
			enabled: true,
			keepRecentTokens: 1,
			maxMediaAttachments: 4,
			maxMediaBytes: 1024,
			maxMediaTokens: 128,
			modelContextLimit: 10_000,
			overflowRecoveryAvailable: false,
			reserveTokens: 1000,
			thresholdTokens: null,
		}),
	resolveFileMentions: async () => [],
	turnRunner: {
		requestOverheadTokens: () => 0,
		run: async () => ({}),
	},
	skills: {
		createTurnSkill: async () =>
			fromPartial<SessionSkillCatalog>({ diagnostic: null }),
		resolveSkill: async () => ({ ok: true }),
	},
	...overrides,
	commitRecord: overrides.commitRecord ?? (async () => undefined),
	updateSubmissionStatus:
		overrides.updateSubmissionStatus ?? (async () => undefined),
});

const createTestAgentSession = (
	initialTranscript: readonly SessionMessage[],
	compactionModule = createCompactionModule(async () => ({ text: "summary" })),
	overrides: Partial<AgentSessionPorts> = {}
): AgentSessionImpl =>
	new AgentSessionImpl({
		initialTranscript,
		ports: createPorts({ compaction: compactionModule, ...overrides }),
		sessionId: sessionId("agent-session-test"),
	});
test("serializes Session Record writes in Agent Session order after a failure", async () => {
	const commitOrder: SessionMessageId[] = [];
	const firstCommitStarted = Promise.withResolvers<void>();
	const releaseFirstCommit = Promise.withResolvers<void>();
	const sessionKey = sessionId("agent-session-test");
	const recordInput = (id: string) => ({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message: message(id),
			model,
			turnId: agentTurnId(`write-${id}`),
		}),
		sessionId: sessionKey,
	});
	const firstInput = recordInput("first-write");
	const secondInput = recordInput("second-write");
	const firstMessageId = firstInput.record.messages[0]?.id;
	const secondMessageId = secondInput.record.messages[0]?.id;
	if (firstMessageId === undefined || secondMessageId === undefined) {
		throw new Error("The test records need user messages.");
	}
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			const messageId = record.messages[0]?.id;
			if (messageId === undefined) {
				throw new Error("The test record has no user message.");
			}
			commitOrder.push(messageId);
			if (messageId === firstMessageId) {
				firstCommitStarted.resolve();
				await releaseFirstCommit.promise;
				throw new Error("The first durable write failed.");
			}
		},
	});

	try {
		const firstWrite = engine.internalPort.commitRecord(firstInput);
		await firstCommitStarted.promise;
		const secondWrite = engine.internalPort.commitRecord(secondInput);
		expect(commitOrder).toEqual([firstMessageId]);

		releaseFirstCommit.resolve();
		await expect(firstWrite).rejects.toThrow("The first durable write failed.");
		await secondWrite;
		expect(commitOrder).toEqual([firstMessageId, secondMessageId]);
	} finally {
		releaseFirstCommit.resolve();
		await engine.internalPort.shutdown();
	}
});
test("reconciles primary records that finish writing during shutdown", async () => {
	const firstCommitStarted = Promise.withResolvers<void>();
	const releaseFirstCommit = Promise.withResolvers<void>();
	const records: SessionRecord[] = [];
	const commitOrder: SessionMessageId[] = [];
	const sessionKey = sessionId("agent-session-test");
	const recordInput = (id: string) => ({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message: message(id),
			model,
			turnId: agentTurnId(`shutdown-write-${id}`),
		}),
		sessionId: sessionKey,
	});
	const firstInput = recordInput("shutdown-first-write");
	const secondInput = recordInput("shutdown-second-write");
	const firstMessageId = firstInput.record.messages[0]?.id;
	const secondMessageId = secondInput.record.messages[0]?.id;
	if (firstMessageId === undefined || secondMessageId === undefined) {
		throw new Error("The test records need user messages.");
	}
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			const messageId = record.messages[0]?.id;
			if (messageId === undefined) {
				throw new Error("The test record has no user message.");
			}
			commitOrder.push(messageId);
			if (messageId === firstMessageId) {
				firstCommitStarted.resolve();
				await releaseFirstCommit.promise;
			}
			records.push(record);
		},
	});

	try {
		const firstWrite = engine.internalPort.commitRecord(firstInput);
		await firstCommitStarted.promise;
		const secondWrite = engine.internalPort.commitRecord(secondInput);
		const shutdown = engine.internalPort.shutdown();
		releaseFirstCommit.resolve();
		await Promise.all([firstWrite, secondWrite, shutdown]);

		expect(commitOrder).toEqual([firstMessageId, secondMessageId]);
		expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual(
			projectSessionRecords(records).map(({ id }) => id)
		);
	} finally {
		releaseFirstCommit.resolve();
		await engine.internalPort.shutdown();
	}
});
test("keeps primary messages with delegated-prefixed IDs in stored order", async () => {
	const initialMessage = message("delegated-turn:primary-message");
	const nextRecord = {
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message: message("next-primary-message"),
			model,
			turnId: agentTurnId("next-primary-turn"),
		}),
		sessionId: sessionId("agent-session-test"),
	};
	const engine = createTestAgentSession([initialMessage]);

	try {
		await engine.internalPort.commitRecord(nextRecord);
		expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
			initialMessage.id,
			...projectSessionRecords([nextRecord.record]).map(({ id }) => id),
		]);
	} finally {
		await engine.internalPort.shutdown();
	}
});
test("waits for every admitted record write before settling shutdown", async () => {
	const firstCommitStarted = Promise.withResolvers<void>();
	const releaseFirstCommit = Promise.withResolvers<void>();
	const secondCommitStarted = Promise.withResolvers<void>();
	const releaseSecondCommit = Promise.withResolvers<void>();
	const sessionKey = sessionId("agent-session-test");
	const recordInput = (id: string) => ({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message: message(id),
			model,
			turnId: agentTurnId(`drain-write-${id}`),
		}),
		sessionId: sessionKey,
	});
	const firstInput = recordInput("drain-first-write");
	const secondInput = recordInput("drain-second-write");
	const firstMessageId = firstInput.record.messages[0]?.id;
	const secondMessageId = secondInput.record.messages[0]?.id;
	if (firstMessageId === undefined || secondMessageId === undefined) {
		throw new Error("The test records need user messages.");
	}
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			const messageId = record.messages[0]?.id;
			if (messageId === undefined) {
				throw new Error("The test record has no user message.");
			}
			if (messageId === firstMessageId) {
				firstCommitStarted.resolve();
				await releaseFirstCommit.promise;
				throw new Error("The first durable write failed.");
			}
			secondCommitStarted.resolve();
			await releaseSecondCommit.promise;
		},
	});
	const writes: Promise<void>[] = [];
	let shutdown: Promise<void> | undefined;

	try {
		const firstWrite = engine.internalPort.commitRecord(firstInput);
		writes.push(firstWrite);
		await firstCommitStarted.promise;
		const secondWrite = engine.internalPort.commitRecord(secondInput);
		writes.push(secondWrite);
		const shutdownPromise = engine.internalPort.shutdown();
		shutdown = shutdownPromise;
		releaseFirstCommit.resolve();
		await expect(firstWrite).rejects.toThrow("The first durable write failed.");
		await secondCommitStarted.promise;

		expect(
			await Promise.race([
				shutdownPromise.then(
					() => "settled" as const,
					() => "settled" as const
				),
				Bun.sleep(0).then(() => "pending" as const),
			])
		).toBe("pending");

		releaseSecondCommit.resolve();
		await expect(secondWrite).resolves.toBeUndefined();
		await expect(shutdownPromise).rejects.toThrow(
			"The first durable write failed."
		);
	} finally {
		releaseFirstCommit.resolve();
		releaseSecondCommit.resolve();
		await Promise.allSettled(writes);
		await (shutdown ?? engine.internalPort.shutdown()).catch(() => undefined);
	}
});

test("places a committed tool checkpoint before a later steered prompt", async () => {
	const toolCall = toolCallId("order-checkpoint-call");
	const checkpointCommitted = Promise.withResolvers<void>();
	const releaseCheckpoint = Promise.withResolvers<void>();
	const turnFinished = Promise.withResolvers<void>();
	const records: SessionRecord[] = [];
	let assistantMessageId: SessionMessageId | undefined;
	let toolMessageId: SessionMessageId | undefined;
	const toolRecordFor = (turnId: AgentTurnId): SessionRecord => ({
		agentId: agentId("build"),
		id: sessionRecordId(`tool-order-${turnId}`),
		messages: [
			{
				id: sessionMessageId(`tool-${turnId}-${toolCall}`),
				parts: [
					{
						input: { path: "src/index.ts" },
						outcome: { kind: "success", output: "checkpoint output" },
						sequence: 2,
						toolCallId: toolCall,
						toolName: "read",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
		],
		model,
		outcome: { kind: "tool" },
		turnId,
		version: 1,
	});
	const assistantRecordFor = (turnId: AgentTurnId): SessionRecord => ({
		agentId: agentId("build"),
		id: sessionRecordId(`assistant-order-${turnId}`),
		messages: [
			{
				id: sessionMessageId(`assistant-${turnId}`),
				parts: [{ text: "final response", type: "text" }],
				role: "assistant",
			},
		],
		model,
		outcome: {
			kind: "assistant",
			terminal: { finishedAt: 4, kind: "completed" },
		},
		turnId,
		version: 1,
	});
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			records.push(record);
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution }) => {
				const checkpointTurn = assistantMessageId === undefined;
				if (checkpointTurn) {
					const toolRecord = toolRecordFor(execution.turnId);
					assistantMessageId = sessionMessageId(
						`assistant-${execution.turnId}`
					);
					toolMessageId = toolRecord.messages[0]?.id;
					await callbacks.onEvent({
						input: { path: "src/index.ts" },
						sequence: 1,
						toolCallId: toolCall,
						toolName: "read",
						turnId: execution.turnId,
						type: "tool-call-started",
					});
					await callbacks.commitToolCall(toolRecord);
					checkpointCommitted.resolve();
					await releaseCheckpoint.promise;
					await callbacks.onEvent({
						outcome: {
							output: "checkpoint output",
							type: "success",
						},
						sequence: 2,
						toolCallId: toolCall,
						toolName: "read",
						turnId: execution.turnId,
						type: "tool-call-finished",
					});
				}
				await callbacks.onEvent({
					delta: "final response",
					sequence: checkpointTurn ? 3 : 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				await callbacks.commitTerminal(assistantRecordFor(execution.turnId));
				await callbacks.onTerminal({
					finishedAt: 4,
					sequence: checkpointTurn ? 4 : 2,
					turnId: execution.turnId,
					type: "agent-turn-completed",
				});
				turnFinished.resolve();
				return {};
			},
		},
	});
	const active = engine.send(
		sendInput({ userText: "request before checkpoint" })
	);

	try {
		await checkpointCommitted.promise;
		if (toolMessageId === undefined) {
			throw new Error("The tool checkpoint needs a message identity.");
		}
		expect(
			engine.getSnapshot().transcript.some(({ id }) => id === toolMessageId)
		).toBe(true);

		const queued = await engine.send(
			sendInput({ userText: "steer after tool checkpoint" })
		);
		expect(queued).toEqual({ rejected: false });
		expect(userPrompts(engine.getSnapshot().transcript)).not.toContain(
			"steer after tool checkpoint"
		);
		const steering = await engine.steer();
		if (steering.kind !== "steered") {
			throw new Error("The queued Submission was not committed as steering.");
		}

		releaseCheckpoint.resolve();
		await turnFinished.promise;
		await expect(active).resolves.toEqual({ rejected: false });

		const transcript = engine.getSnapshot().transcript;
		const storedTranscript = projectSessionRecords(records);
		expect(transcript.map(({ id }) => id)).toEqual(
			storedTranscript.map(({ id }) => id)
		);
		if (assistantMessageId === undefined) {
			throw new Error("The active turn needs an assistant message identity.");
		}
		const toolIndex = transcript.findIndex(({ id }) => id === toolMessageId);
		const steeringIndex = transcript.findIndex(
			({ id }) => id === steering.messageId
		);
		const assistantIndex = transcript.findIndex(
			({ id }) => id === assistantMessageId
		);
		expect(toolIndex).toBeLessThan(steeringIndex);
		expect(steeringIndex).toBeLessThan(assistantIndex);
	} finally {
		releaseCheckpoint.resolve();
		await engine.internalPort.shutdown();
	}
});
test("appends a committed delegated row with durable identity and grouping", async () => {
	const parentTurnId = agentTurnId("delegated-live-parent");
	const parentToolCallId = toolCallId("delegated-live-parent-call");
	const primaryRecord = buildUserSessionRecord({
		agentId: agentId("build"),
		message: message("delegated-live-primary", "primary request"),
		model,
		turnId: agentTurnId("delegated-live-primary-turn"),
	});
	const records: SessionRecord[] = [primaryRecord];
	const initialTranscript = projectSessionRecords(records);
	const delegatedRecord: SessionRecord = {
		agentId: agentId("research"),
		delegation: { parentToolCallId, parentTurnId },
		id: sessionRecordId("delegated-live-assistant-record"),
		messages: [
			{
				id: sessionMessageId("assistant-delegated-live-child"),
				parts: [{ text: "delegated response", type: "text" }],
				role: "assistant",
			},
		],
		model,
		outcome: {
			kind: "assistant",
			terminal: { finishedAt: 1, kind: "completed" },
		},
		turnId: agentTurnId("delegated-live-child"),
		version: 1,
	};
	const engine = createTestAgentSession(initialTranscript, undefined, {
		commitRecord: async ({ record }) => {
			records.push(record);
		},
	});

	try {
		await engine.internalPort.commitRecord({
			record: delegatedRecord,
			sessionId: sessionId("agent-session-test"),
		});

		const transcript = engine.getSnapshot().transcript;
		const storedTranscript = projectSessionRecords(records);
		expect(transcript.map(({ id }) => id)).toEqual(
			storedTranscript.map(({ id }) => id)
		);
		expect(transcript[0]?.id).toBe(initialTranscript[0]?.id);
		expect(transcript.at(-1)?.id).toBe(storedTranscript.at(-1)?.id);
	} finally {
		await engine.internalPort.shutdown();
	}
});
test("removes a failed tool checkpoint from the live transcript and retains its error", async () => {
	const callId = toolCallId("failed-order-checkpoint-call");
	const records: SessionRecord[] = [];
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			if (record.outcome.kind === "tool") {
				throw new Error("tool checkpoint write failed");
			}
			records.push(record);
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution }) => {
				await callbacks.onEvent({
					input: { path: "src/index.ts" },
					sequence: 1,
					toolCallId: callId,
					toolName: "read",
					turnId: execution.turnId,
					type: "tool-call-started",
				});
				await callbacks.commitToolCall({
					agentId: agentId("build"),
					id: sessionRecordId("failed-order-checkpoint"),
					messages: [
						{
							id: sessionMessageId("failed-order-checkpoint-message"),
							parts: [
								{
									input: { path: "src/index.ts" },
									outcome: {
										kind: "success",
										output: "checkpoint output",
									},
									sequence: 2,
									toolCallId: callId,
									toolName: "read",
									type: "tool-call",
								},
							],
							role: "assistant",
						},
					],
					model,
					outcome: { kind: "tool" },
					turnId: execution.turnId,
					version: 1,
				});
				return {};
			},
		},
	});

	try {
		await expect(
			engine.send(sendInput({ userText: "request before failed checkpoint" }))
		).resolves.toEqual({ rejected: false });

		const snapshot = engine.getSnapshot();
		expect(snapshot.error?.message).toBe("tool checkpoint write failed");
		expect(
			snapshot.transcript.some(({ parts }) =>
				parts.some((part) => "toolCallId" in part && part.toolCallId === callId)
			)
		).toBe(false);
		expect(records.some(({ outcome }) => outcome.kind === "tool")).toBe(false);
	} finally {
		await engine.internalPort.shutdown();
	}
});

test("logs unexpected submission preparation failures without user content", async () => {
	await withLoggerHome(async (home) => {
		const turnId = agentTurnId("preparation-turn");
		const engine = createTestAgentSession([], undefined, {
			resolveCompactionSettings: async () => {
				throw Object.assign(new Error("private preparation detail"), {
					code: "SETTINGS_FAILED",
				});
			},
		});
		try {
			expect(
				await engine.send(
					sendInput({ turnId, userText: "private prompt text" })
				)
			).toMatchObject({ rejected: true });
			await logger.flush();
			const records = await readLoggerRecords(home).catch(() => []);
			const preparationRecords = records.filter(
				({ message }) => message === "Session submission preparation failed"
			);
			expect(preparationRecords).toHaveLength(1);
			expect(preparationRecords[0]).toMatchObject({
				context: {
					errorCode: "SETTINGS_FAILED",
					errorType: "Error",
					operation: "session.submission",
					phase: "preparation",
					turnId,
				},
				level: "error",
			});
			expect(JSON.stringify(preparationRecords[0])).not.toContain(
				"private preparation detail"
			);
			expect(JSON.stringify(preparationRecords[0])).not.toContain(
				"private prompt text"
			);
		} finally {
			await engine.internalPort.shutdown();
		}
	});
});

test("keeps the admission turn ID on preparation-triggered threshold diagnostics", async () => {
	await withLoggerHome(async (home) => {
		const turnId = agentTurnId("threshold-preparation-turn");
		const engine = createTestAgentSession(
			compactionHistory(),
			createCompactionModule(async () => {
				throw new Error("private summary failure");
			}),
			{
				resolveCompactionSettings: async () =>
					fromPartial<ResolvedCompactionSettings>({
						autoAvailable: true,
						enabled: true,
						keepRecentTokens: 1,
						maxMediaAttachments: 4,
						maxMediaBytes: 1024,
						maxMediaTokens: 128,
						modelContextLimit: 10_000,
						overflowRecoveryAvailable: false,
						reserveTokens: 1000,
						thresholdTokens: 1,
					}),
			}
		);
		try {
			expect(
				await engine.send(
					sendInput({ turnId, userText: "private preparation prompt" })
				)
			).toMatchObject({ rejected: true });
			await logger.flush();

			const failureRecords = await readLoggerRecords(home);
			const compactionFailure = failureRecords.find(
				({ message }) => message === "Session compaction failed"
			);
			expect(compactionFailure).toMatchObject({
				context: {
					errorCode: "summary-failed",
					errorType: "SessionCompactionError",
					operation: "session.compaction",
					phase: "failed",
					trigger: "threshold",
					turnId,
				},
				level: "warn",
			});
			expect(JSON.stringify(compactionFailure)).not.toContain(
				"private summary failure"
			);
			expect(JSON.stringify(compactionFailure)).not.toContain(
				"private preparation prompt"
			);
		} finally {
			await engine.internalPort.shutdown();
		}
	});
});

test("publishes snapshots only when public commands change session facts", async () => {
	const engine = createTestAgentSession([]);
	const initial = engine.getSnapshot();
	let notifications = 0;
	const unsubscribe = engine.subscribe(() => {
		notifications += 1;
	});

	expect(await engine.interruptAll()).toMatchObject({
		approvalsSettled: 0,
		kind: "none",
		recalled: [],
	});
	expect(engine.getSnapshot()).toBe(initial);
	expect(notifications).toBe(0);

	await engine.send(sendInput({ userText: "first prompt" }));
	const changed = engine.getSnapshot();
	expect(changed).not.toBe(initial);
	expect(notifications).toBeGreaterThan(0);

	unsubscribe();
	const settledNotifications = notifications;
	await engine.send(sendInput({ userText: "second prompt" }));
	expect(notifications).toBe(settledNotifications);
});

test("isolates a failing observer from public session commands and other observers", async () => {
	const engine = createTestAgentSession([]);
	let observed = 0;
	engine.subscribe(() => {
		throw new Error("observer failed");
	});
	engine.subscribe(() => {
		observed += 1;
	});

	await engine.send(sendInput({ userText: "observer-safe prompt" }));

	expect(userPrompts(engine.getSnapshot().context)).toContain(
		"observer-safe prompt"
	);
	expect(observed).toBeGreaterThan(0);
});

test("runs a compaction command and publishes what it produced", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);

	const command = engine.compact({
		model,
		trigger: "threshold",
	});

	expect(engine.getSnapshot().isCompacting).toBe(true);
	release();
	const result = await command;

	const snapshot = engine.getSnapshot();
	expect(snapshot.isCompacting).toBe(false);
	expect(snapshot.compactions.map(({ id }) => id)).toEqual([result.entry.id]);
	expect(snapshot.context.map(({ id }) => id)).toEqual(
		result.activeMessages.map(({ id }) => id)
	);
});

test("starts queued work only after compaction publishes its new Context", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const receivedMessages = Promise.withResolvers<readonly SessionMessage[]>();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async ({ messages }) => {
					receivedMessages.resolve(messages);
					return {};
				},
			},
		}
	);
	const compaction = engine.compact({ model, trigger: "threshold" });
	const admission = await engine.prompt(
		sendInput({ userText: "after compaction" })
	);

	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	release();
	await compaction;
	const received = await receivedMessages.promise;

	expect(engine.getSnapshot().isCompacting).toBe(false);
	expect(received.map(({ id }) => id)).toContain(
		compactionSummaryMessageId(compactionId("entry-compacted"))
	);
	expect(userPrompts(received)).toContain("after compaction");
	await engine.internalPort.shutdown();
});

test("settles a joined command only after the swap it joins has landed", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const owner = engine.compact({
		model,
		trigger: "threshold",
	});
	const joined = engine.compact({
		model,
		trigger: "threshold",
	});

	release();
	await joined;

	expect(engine.getSnapshot().context[0]?.id).toBe(
		compactionSummaryMessageId(compactionId("entry-compacted"))
	);
	await owner;
});

test("refuses another intent's compaction without disturbing the running command", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const automatic = engine.compact({
		model,
		trigger: "threshold",
	});

	await expect(
		engine.compact({
			focus: "preserve database decisions",
			model,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "in-flight" });

	expect(engine.getSnapshot().isCompacting).toBe(true);
	release();
	const result = await automatic;
	expect(result.entry.trigger).toBe("threshold");
	expect(result.entry.focus).toBeUndefined();
	expect(
		engine.getSnapshot().compactions.map(({ trigger }) => trigger)
	).toEqual(["threshold"]);
});

test("cancels the compaction command in flight without publishing its result", async () => {
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule((input) => {
			const { promise, reject } = Promise.withResolvers<{ text: string }>();
			const cancel = () => reject(new Error("summary cancelled"));
			if (input.signal?.aborted) {
				cancel();
			} else {
				input.signal?.addEventListener("abort", cancel, { once: true });
			}
			return promise;
		})
	);

	const command = engine.compact({
		model,
		trigger: "threshold",
	});
	await engine.cancelCompaction();

	await expect(command).rejects.toMatchObject({ code: "cancelled" });
	const snapshot = engine.getSnapshot();
	expect(snapshot.isCompacting).toBe(false);
	expect(snapshot.compactions).toEqual([]);
	expect(snapshot.context.map(({ id }) => id)).toEqual(
		compactionHistory().map(({ id }) => id)
	);
});

test("interruptAll settles idle approvals and reports no stopped work", async () => {
	const engine = createTestAgentSession([]);
	const approval = engine.internalPort.requestApproval(
		fromPartial<ToolApprovalRequest>({
			toolCallId: toolCallId("idle-approval"),
		})
	);

	expect(await engine.interruptAll()).toMatchObject({
		approvalsSettled: 1,
		kind: "none",
		recalled: [],
	});
	await expect(approval).resolves.toEqual({ decision: "reject" });
});

test("interruptAll aborts compaction and recalls queued submissions", async () => {
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule((input) => {
			const { promise, reject } = Promise.withResolvers<{ text: string }>();
			const cancel = () => reject(new Error("summary cancelled"));
			if (input.signal?.aborted) {
				cancel();
			} else {
				input.signal?.addEventListener("abort", cancel, { once: true });
			}
			return promise;
		})
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "waiting" }));

	const result = await engine.interruptAll();

	expect(result.kind).toBe("compaction");
	expect(result.approvalsSettled).toBe(0);
	expect(result.recalled.map(({ input }) => input.composition.text)).toEqual([
		"waiting",
	]);
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	expect(engine.getSnapshot().isCompacting).toBe(false);
});

test("merges a command's own transcript update before compacting", async () => {
	const engine = createTestAgentSession(compactionHistory());

	const result = await engine.compact({
		model,
		nextMessages: [message("a3", "terminal answer")],
		trigger: "threshold",
	});

	expect(result.entry.trigger).toBe("threshold");
	// The update is in the Session Transcript only because the command merged it,
	// and only then can the retained tail carry it into the Session Context.
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		...compactionHistory().map(({ id }) => id),
		sessionMessageId("a3"),
	]);
	expect(engine.getSnapshot().context.map(({ id }) => id)).toContain(
		sessionMessageId("a3")
	);
});

test("compacts a command's own source without touching the Transcript", async () => {
	const engine = createTestAgentSession([message("a9", "unrelated")]);

	const result = await engine.compact({
		model,
		sourceMessages: compactionHistory(),
		trigger: "overflow",
	});

	expect(result.entry.trigger).toBe("overflow");
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		sessionMessageId("a9"),
	]);
	// The retained tail comes from the supplied source, not the Transcript.
	expect(engine.getSnapshot().context.map(({ id }) => id)).toEqual([
		compactionSummaryMessageId(compactionId("entry-compacted")),
		sessionMessageId("a2"),
	]);
});
test("debug compaction records manual lifecycle transitions", async () => {
	await withLoggerHome(async (home) => {
		await withDebugProject(home, async () => {
			const engine = createTestAgentSession(compactionHistory());
			try {
				const result = await engine.compact({ model, trigger: "manual" });
				expect(result.entry.trigger).toBe("manual");
			} finally {
				await engine.internalPort.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const compactionRecords = records.filter(
				({ context }) => context?.operation === "session.compaction"
			);
			for (const phase of ["started", "completed"]) {
				expect(compactionRecords).toContainEqual(
					expect.objectContaining({
						context: expect.objectContaining({
							phase,
							trigger: "manual",
						}),
						level: "debug",
					})
				);
			}
		});
	});
});

const approvalRequest = (callId?: string): ToolApprovalRequest => ({
	description: "Write denied by policy: src/index.ts",
	identity: [{ label: "tool", value: "write" }],
	input: { path: "src/index.ts" },
	...(callId === undefined ? {} : { toolCallId: toolCallId(callId) }),
});

test("publishes a pending approval and settles it exactly once", async () => {
	const engine = createTestAgentSession([]);
	const settled = engine.internalPort.requestApproval(
		approvalRequest("call-1")
	);

	const pending = engine.getSnapshot().approvals;
	expect(pending.map(({ id, target }) => [id, target])).toEqual([
		["call-1", "tool-call"],
	]);
	expect(pending[0]?.decision).toBeUndefined();

	engine.respondToApproval("call-1", { decision: "allow", remember: false });

	await expect(settled).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
	expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
		decision: "allow",
		remember: false,
	});

	// A second trigger cannot settle a request the Agent Session already settled.
	engine.respondToApproval("call-1", { decision: "abort" });
	await expect(settled).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
	expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
		decision: "allow",
		remember: false,
	});
});
test("keeps a safety approval pending when persistence is requested", async () => {
	const engine = createTestAgentSession([]);
	const settled = engine.internalPort.requestApproval({
		...approvalRequest("call-safety"),
		safety: true,
	});

	expect(
		engine.respondToApproval("call-safety", {
			decision: "allow",
			remember: true,
		})
	).toEqual({
		applied: false,
		reason: "persistence-forbidden",
	});
	expect(engine.getSnapshot().approvals[0]?.decision).toBeUndefined();

	engine.respondToApproval("call-safety", {
		decision: "allow",
		remember: false,
	});
	await expect(settled).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
});
test("aborts the active turn through an approval response", async () => {
	const streaming = createStreamingRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: streaming.runtime,
	});
	const send = engine.send(sendInput());

	await streaming.live;
	const settled = engine.internalPort.requestApproval(
		approvalRequest("call-abort")
	);

	expect(engine.respondToApproval("call-abort", { decision: "abort" })).toEqual(
		{ applied: true }
	);
	await expect(settled).resolves.toEqual({ decision: "abort" });
	expect(engine.getSnapshot().turnActive).toBe(false);

	streaming.release();
	await send;
	expect(
		engine.getSnapshot().context.findLast(({ role }) => role === "assistant")
			?.metadata?.interrupted
	).toBe(true);
});

test("gives a Tool-Call-less approval its own id and settles it with every sibling", async () => {
	const engine = createTestAgentSession([]);
	const first = engine.internalPort.requestApproval(approvalRequest());
	const second = engine.internalPort.requestApproval(approvalRequest());
	const [firstEntry, secondEntry] = engine.getSnapshot().approvals;

	expect(firstEntry?.target).toBe("session");
	expect(firstEntry?.id).toBeString();
	expect(firstEntry?.id).not.toBe(secondEntry?.id);

	await engine.interruptAll();
	await expect(first).resolves.toEqual({ decision: "reject" });
	await expect(second).resolves.toEqual({ decision: "reject" });
});

test("interruptAll settles every pending approval", async () => {
	const engine = createTestAgentSession([]);
	const first = engine.internalPort.requestApproval(approvalRequest("call-1"));
	const second = engine.internalPort.requestApproval(approvalRequest("call-2"));

	await engine.interruptAll();

	await expect(first).resolves.toEqual({ decision: "reject" });
	await expect(second).resolves.toEqual({ decision: "reject" });
	expect(
		engine.getSnapshot().approvals.map(({ decision }) => decision)
	).toEqual([{ decision: "reject" }, { decision: "reject" }]);
});

test("refuses a second pending request that reuses a Tool Call Identifier", async () => {
	const engine = createTestAgentSession([]);
	const first = engine.internalPort.requestApproval(approvalRequest("call-1"));
	const duplicate = engine.internalPort.requestApproval(
		approvalRequest("call-1")
	);

	await expect(duplicate).resolves.toEqual({ decision: "reject" });
	expect(engine.getSnapshot().approvals).toHaveLength(1);

	// The identifier still addresses the request the panel shows.
	engine.respondToApproval("call-1", { decision: "allow", remember: false });
	await expect(first).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
});

test("keeps the first settlement when an abort and a close race", async () => {
	const engine = createTestAgentSession([]);
	const aborted = engine.internalPort.requestApproval(
		approvalRequest("call-1")
	);
	const sibling = engine.internalPort.requestApproval(
		approvalRequest("call-2")
	);

	engine.respondToApproval("call-1", { decision: "abort" });
	await engine.interruptAll();

	await expect(aborted).resolves.toEqual({ decision: "abort" });
	await expect(sibling).resolves.toEqual({ decision: "reject" });
});

/** The provider's public context-window refusal. */
const overflowFailure = (): Error =>
	new Error("This model's maximum context length is 128000 tokens.");
const overflowOperationalFailure = (): OperationalFailure => ({
	code: "context-overflow",
	message: "The model context is too large.",
	retry: "never",
	source: "model",
	version: 1,
});
const overflowRecoverySettings = (): ResolvedCompactionSettings =>
	fromPartial<ResolvedCompactionSettings>({
		autoAvailable: false,
		enabled: true,
		keepRecentTokens: 1,
		maxMediaAttachments: 4,
		maxMediaBytes: 1024,
		maxMediaTokens: 128,
		modelContextLimit: 10_000,
		overflowRecoveryAvailable: true,
		reserveTokens: 1000,
		thresholdTokens: null,
	});

const reportTurnStarted = ({
	callbacks,
	execution,
}: SessionTurnRequest): void => {
	callbacks.onEvent({
		agentId: execution.agent,
		sequence: 0,
		startedAt: 1,
		turnId: execution.turnId,
		type: "agent-turn-started",
	});
};

const completeRuntimeTurn = async ({
	callbacks,
	execution,
}: SessionTurnRequest): Promise<void> => {
	await callbacks.commitTerminal(
		fromPartial<SessionRecord>({
			messages: [
				{
					id: sessionMessageId(`assistant-${execution.turnId}`),
					parts: [{ text: "answer", type: "text" }],
					role: "assistant",
				},
			],
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 2, kind: "completed" },
			},
			turnId: execution.turnId,
		})
	);
	callbacks.onTerminal({
		finishedAt: 2,
		sequence: 2,
		turnId: execution.turnId,
		type: "agent-turn-completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	});
};

const overflowTurnRunner: AgentSessionPorts["turnRunner"] = {
	requestOverheadTokens: () => 0,
	run: async (request) => {
		reportTurnStarted(request);
		return { error: overflowFailure() };
	},
};

const createOverflowTestSession = (
	initialTranscript: readonly SessionMessage[] = [],
	overrides: Partial<AgentSessionPorts> = {},
	summaryGenerator: SummaryGenerator = async () => ({ text: "summary" })
): AgentSessionImpl =>
	createTestAgentSession(
		initialTranscript,
		createCompactionModule(summaryGenerator),
		{
			resolveCompactionSettings: async () => overflowRecoverySettings(),
			turnRunner: overflowTurnRunner,
			...overrides,
		}
	);

/** One submission as a view sends it: a prompt, its selection, its Agent. */
const sendInput = (
	overrides: Partial<SessionSendInput> = {}
): SessionSendInput => ({
	agent: agentId("build"),
	model,
	resolvedAgent: fromPartial<ResolvedCodingAgent>({}),
	sessionModel: model,
	userText: "hello",
	...overrides,
});

/** The visible composition one submission is accepted with. */
const compositionOf = (
	text: string,
	files: SessionFilePart[] = []
): SessionSubmissionComposition => ({
	files,
	text,
});

/** The prompt of every user message in a conversation, in order. */
const userPrompts = (messages: readonly SessionMessage[]): string[] =>
	messages.flatMap(({ parts, role }) =>
		role === "user"
			? parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
			: []
	);

/** The prompt one Agent Turn sends: its newest user message. */
const promptOfTurn = (messages: readonly SessionMessage[]): string =>
	userPrompts(messages).at(-1) ?? "";

/**
 * A runtime that holds every Agent Turn until the test releases it, one release
 * per started turn, and records what each turn ran with, so queue order is
 * observed through awaited starts rather than through waiting on real time.
 * With `boundary` it also models one Model Step boundary per turn: it asks the
 * Engine what joined the turn and records what it was handed, exactly where a
 * real runtime inserts a Steering Message before its next model call.
 */
const createQueuedRuntime = ({
	boundary = false,
}: {
	boundary?: boolean;
} = {}): {
	/**
	 * What each Model Step boundary of each turn was handed, in boundary order,
	 * with the message that turn still answers when it delivered.
	 */
	readonly boundaries: Array<{
		readonly delivered: string[];
		readonly hydratedAttachmentCount: number;
		readonly sourceUserMessageId: SessionMessageId | null;
	}>;
	/** The prompt each started turn answers, in start order. */
	readonly prompts: string[];
	/** Lets the oldest started Agent Turn finish. */
	readonly release: () => void;
	readonly runtime: AgentSessionPorts["turnRunner"];
	/** Resolves once `count` Agent Turns have started. */
	readonly started: (count: number) => Promise<void>;
	/** The Model Target selection each started turn ran with, in start order. */
	readonly targets: Array<{
		model: ChatModelSelection;
		effort: Effort | undefined;
		reasoningMode: ReasoningMode | undefined;
	}>;
} => {
	const boundaries: Array<{
		delivered: string[];
		hydratedAttachmentCount: number;
		sourceUserMessageId: SessionMessageId | null;
	}> = [];
	const gates: Array<() => void> = [];
	const prompts: string[] = [];
	const targets: Array<{
		model: ChatModelSelection;
		effort: Effort | undefined;
		reasoningMode: ReasoningMode | undefined;
	}> = [];
	const startWaiters: Array<{ count: number; resolve: () => void }> = [];
	let startedCount = 0;
	const settleReached = (
		waiters: Array<{ count: number; resolve: () => void }>,
		count: number
	): void => {
		for (const waiter of waiters.filter(({ count: at }) => at <= count)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};
	const awaited = (
		waiters: Array<{ count: number; resolve: () => void }>,
		reached: number,
		count: number
	): Promise<void> => {
		if (count <= reached) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ count, resolve });
		return promise;
	};
	return {
		boundaries,
		prompts,
		release: () => gates.shift()?.(),
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, messages, takeSteeringMessages }) => {
				prompts.push(promptOfTurn(messages));
				targets.push({
					model: execution.model,
					effort: execution.effort,
					reasoningMode: execution.reasoningMode,
				});
				startedCount += 1;
				settleReached(startWaiters, startedCount);
				const gate = Promise.withResolvers<void>();
				gates.push(gate.resolve);
				await gate.promise;
				if (boundary) {
					const deliveredMessages = await takeSteeringMessages();
					boundaries.push({
						delivered: userPrompts(deliveredMessages),
						hydratedAttachmentCount: deliveredMessages
							.flatMap(({ parts }) => parts)
							.filter(
								(part) => part.type === "file" && part.url.startsWith("data:")
							).length,
						sourceUserMessageId: execution.sourceUserMessageId,
					});
					callbacks.onEvent(
						fromPartial<AgentTurnEvent>({
							modelId: execution.model.modelId,
							sequence: 1,
							stepId: `step-${execution.turnId}`,
							turnId: execution.turnId,
							type: "model-step-finished",
						})
					);
				}
				await callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						messages: [
							{
								id: sessionMessageId(`assistant-${execution.turnId}`),
								parts: [{ text: "answer", type: "text" }],
								role: "assistant",
							},
						],
						outcome: {
							kind: "assistant",
							terminal: { finishedAt: 2, kind: "completed" },
						},
						turnId: execution.turnId,
					})
				);
				callbacks.onTerminal({
					finishedAt: 2,
					sequence: 2,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
		started: (count) => awaited(startWaiters, startedCount, count),
		targets,
	};
};

test("prompt queues a second submission instead of steering a live turn", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
	const started = await engine.prompt(sendInput({ userText: "first" }));
	if (started.rejected) {
		throw new Error(started.reason);
	}
	await runtime.started(1);

	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("queued-file"),
			mediaType: "image/png",
			type: "file",
			url: "attachment://queued-file",
		}),
	];
	const composition = compositionOf("second with file", files);
	const queued = await engine.prompt(
		sendInput({
			composition,
			files,
			userText: "second with file",
		})
	);

	expect(queued).toMatchObject({ rejected: false, disposition: "queued" });
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions[0]?.input.composition).toEqual(
		composition
	);
	expect(engine.continue().kind).toBe("rejected");

	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["first", "second with file"]);
	runtime.release();
	await engine.internalPort.shutdown();
});

test("compatibility send queues while the active submission is still preparing", async () => {
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		attachments: {
			externalize: async (messages) => {
				externalizeStarted.resolve();
				await allowExternalize.promise;
				return [...messages];
			},
			hydrate: async ({ messages }) => [...messages],
			release: () => undefined,
			retain: () => undefined,
		},
		turnRunner: runtime.runtime,
	});
	const files: SessionFilePart[] = [
		{
			filename: "first.txt",
			mediaType: "text/plain",
			type: "file",
			url: "data:text/plain;base64,QQ==",
		},
	];
	const started = await engine.prompt(sendInput({ files, userText: "first" }));
	if (started.rejected) {
		throw new Error(started.reason);
	}
	await externalizeStarted.promise;

	const queued = await engine.send(sendInput({ userText: "second" }));
	const preparingSnapshot = engine.getSnapshot();

	expect(queued).toEqual({ rejected: false });
	expect(preparingSnapshot.turnActive).toBe(true);
	expect(
		preparingSnapshot.queuedSubmissions.map(
			({ input }) => input.composition.text
		)
	).toEqual(["second"]);
	expect(runtime.prompts).toEqual([]);

	allowExternalize.resolve();
	await runtime.started(1);
	expect(runtime.prompts).toEqual(["first"]);
	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["first", "second"]);
	runtime.release();
	await engine.internalPort.shutdown();
});

test("admits queued attachment prompts before externalization finishes in FIFO order", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => {
					externalizeStarted.resolve();
					await allowExternalize.promise;
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
			turnRunner: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];
	const compaction = engine.compact({ model, trigger: "manual" });
	const firstAdmissionPromise = engine.prompt(
		sendInput({
			composition: compositionOf("first with file", files),
			files,
			userText: "first with file",
		})
	);
	await externalizeStarted.promise;
	let firstAdmissionResolved = false;
	void firstAdmissionPromise.then(() => {
		firstAdmissionResolved = true;
	});
	await Promise.resolve();
	const admittedBeforeExternalization = firstAdmissionResolved;
	const secondAdmission = await engine.prompt(
		sendInput({ userText: "second" })
	);
	const queuedOrderBeforeExternalization = engine
		.getSnapshot()
		.queuedSubmissions.map(({ input }) => input.composition.text);

	allowExternalize.resolve();
	await firstAdmissionPromise;
	release();
	await compaction;
	await runtime.started(1);
	const firstStartedPrompt = runtime.prompts[0];
	runtime.release();
	await runtime.started(2);
	const secondStartedPrompt = runtime.prompts[1];
	runtime.release();
	await engine.internalPort.shutdown();

	expect(admittedBeforeExternalization).toBe(true);
	expect(secondAdmission).toMatchObject({
		disposition: "queued",
		rejected: false,
	});
	expect(queuedOrderBeforeExternalization).toEqual([
		"first with file",
		"second",
	]);
	expect(firstStartedPrompt).toBe("first with file");
	expect(secondStartedPrompt).toBe("second");
});

test("interruptAll recalls queued attachments before externalization completes", async () => {
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	let externalizeSignal: AbortSignal | undefined;
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule((input) => {
			const { promise, reject } = Promise.withResolvers<{ text: string }>();
			const cancel = () => reject(new Error("summary cancelled"));
			if (input.signal?.aborted) {
				cancel();
			} else {
				input.signal?.addEventListener("abort", cancel, { once: true });
			}
			return promise;
		}),
		{
			attachments: {
				externalize: async (messages, signal) => {
					externalizeSignal = signal;
					externalizeStarted.resolve();
					await allowExternalize.promise;
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
		}
	);
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];
	const compaction = engine.compact({ model, trigger: "manual" });
	const admissionPromise = engine.prompt(
		sendInput({
			composition: compositionOf("waiting", files),
			files,
			userText: "waiting",
		})
	);
	await externalizeStarted.promise;
	const interruptedPromise = engine.interruptAll();
	const externalizationAborted = externalizeSignal?.aborted ?? false;
	const queueAfterInterrupt = engine.getSnapshot().queuedSubmissions;

	allowExternalize.resolve();
	const admission = await admissionPromise;
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	await engine.internalPort.shutdown();

	const interrupted = await interruptedPromise;
	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	expect(
		interrupted.recalled.map(({ input }) => input.composition.text)
	).toEqual(["waiting"]);
	expect(externalizationAborted).toBe(true);
	expect(queueAfterInterrupt).toEqual([]);
});

test("continue resumes the last user context without appending another prompt", async () => {
	const runtime = createQueuedRuntime();
	const refreshedModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};
	const stored = fromPartial<SessionMessage>({
		id: sessionMessageId("u-continue"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "continue me", type: "text" }],
		role: "user",
	});
	const resolvedInputs: SessionSendInput[] = [];
	const engine = createTestAgentSession([stored], undefined, {
		resolveSubmission: (input) => {
			resolvedInputs.push(input);
			return {
				...input,
				model: refreshedModel,
				resolvedAgent: sendInput().resolvedAgent,
			};
		},
		turnRunner: runtime.runtime,
	});

	const outcome = engine.continue();
	expect(outcome.kind).toBe("resumed");
	await runtime.started(1);

	expect(runtime.prompts).toEqual(["continue me"]);
	expect(runtime.targets).toEqual([
		{
			model: refreshedModel,
			effort: undefined,
			reasoningMode: undefined,
		},
	]);
	expect(resolvedInputs).toHaveLength(1);
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([stored]);
	runtime.release();
	await engine.internalPort.shutdown();
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([stored]);
});

test("continue retains completed Tool Calls as context without rerunning them", async () => {
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u-tool-context"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "inspect this", type: "text" }],
		role: "user",
	});
	const toolMessage = fromPartial<SessionMessage>({
		id: sessionMessageId("a-tool-context"),
		metadata: {
			agent: agentId("build"),
			model,
			sourceUserMessageId: user.id,
		},
		parts: [
			{
				input: { path: "file.txt" },
				output: { text: "contents" },
				state: "output-available",
				toolCallId: toolCallId("call-complete"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});
	const messagesSeen: SessionMessage[][] = [];
	const completed = Promise.withResolvers<void>();
	const answer = answeringRuntime();
	const engine = createTestAgentSession([user, toolMessage], undefined, {
		resolveSubmission: (input) => ({
			...input,
			resolvedAgent: sendInput().resolvedAgent,
		}),
		turnRunner: {
			requestOverheadTokens: answer.requestOverheadTokens,
			run: async (request) => {
				messagesSeen.push([...request.messages]);
				const outcome = await answer.run(request);
				completed.resolve();
				return outcome;
			},
		},
	});

	expect(engine.continue().kind).toBe("resumed");
	await completed.promise;
	await engine.internalPort.shutdown();

	expect(messagesSeen).toEqual([[user, toolMessage]]);
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([user]);
	expect(
		engine
			.getSnapshot()
			.context.flatMap(({ parts }) =>
				parts.filter(
					(part) =>
						"type" in part &&
						part.type === "tool-read" &&
						"toolCallId" in part &&
						part.toolCallId === toolCallId("call-complete")
				)
			)
	).toHaveLength(1);
});
test("continue resumes retained denied Tool Calls without rerunning them", async () => {
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u-denied-context"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "run a protected tool", type: "text" }],
		role: "user",
	});
	const toolMessage = fromPartial<SessionMessage>({
		id: sessionMessageId("a-denied-context"),
		metadata: {
			agent: agentId("build"),
			model,
			sourceUserMessageId: user.id,
		},
		parts: [
			{
				approval: { approved: false },
				input: { path: "secret.txt" },
				state: "output-denied",
				toolCallId: toolCallId("call-denied"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});
	const messagesSeen: SessionMessage[][] = [];
	const completed = Promise.withResolvers<void>();
	const answer = answeringRuntime();
	const engine = createTestAgentSession([user, toolMessage], undefined, {
		resolveSubmission: (input) => ({
			...input,
			resolvedAgent: sendInput().resolvedAgent,
		}),
		turnRunner: {
			requestOverheadTokens: answer.requestOverheadTokens,
			run: async (request) => {
				messagesSeen.push([...request.messages]);
				const outcome = await answer.run(request);
				completed.resolve();
				return outcome;
			},
		},
	});

	expect(engine.continue().kind).toBe("resumed");
	await completed.promise;
	await engine.internalPort.shutdown();

	expect(messagesSeen).toEqual([[user, toolMessage]]);
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([user]);
	expect(
		engine
			.getSnapshot()
			.context.flatMap(({ parts }) =>
				parts.filter(
					(part) =>
						"type" in part &&
						part.type === "tool-read" &&
						"toolCallId" in part &&
						part.toolCallId === toolCallId("call-denied")
				)
			)
	).toHaveLength(1);
});

test("continue rejects incomplete Tool Calls even when a later user is last", async () => {
	let runtimeStarts = 0;
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u-incomplete"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "run a tool", type: "text" }],
		role: "user",
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a-incomplete"),
		metadata: {
			agent: agentId("build"),
			model,
			sourceUserMessageId: user.id,
		},
		parts: [
			{
				input: { path: "file.txt" },
				state: "input-available",
				toolCallId: toolCallId("call-incomplete"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});
	const laterUser = fromPartial<SessionMessage>({
		id: sessionMessageId("u-after-incomplete"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "continue anyway", type: "text" }],
		role: "user",
	});
	const engine = createTestAgentSession(
		[user, assistant, laterUser],
		undefined,
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async () => {
					runtimeStarts += 1;
					return {};
				},
			},
		}
	);

	expect(engine.continue()).toMatchObject({ kind: "rejected" });
	expect(runtimeStarts).toBe(0);
	await engine.internalPort.shutdown();
});

test("starts a queued admission with the identity it reserved", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);
	const events: SessionSubmissionEvent[] = [];
	engine.onSubmissionEvent((event) => events.push(event));

	const compaction = engine.compact({ model, trigger: "manual" });
	const queued = await engine.prompt(sendInput({ userText: "queued" }));
	if (queued.rejected) {
		throw new Error(queued.reason);
	}
	expect(queued.disposition).toBe("queued");
	expect(events).toEqual([]);

	release();
	await compaction;
	await runtime.started(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		kind: "started",
		messageId: queued.messageId,
		submissionId: queued.submissionId,
	});
	expect(events[0]?.turnId).toBeDefined();
	runtime.release();
	await engine.internalPort.shutdown();
});

test("recalls a queued admission before it creates a Session Record", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const events: SessionSubmissionEvent[] = [];
	engine.onSubmissionEvent((event) => events.push(event));

	const compaction = engine.compact({ model, trigger: "manual" });
	const queued = await engine.prompt(sendInput({ userText: "withdraw me" }));
	if (queued.rejected) {
		throw new Error(queued.reason);
	}
	const recalled = await engine.recallWaitingMessages([queued.submissionId]);

	expect(recalled).toHaveLength(1);
	const recalledQueued = recalled[0];
	if (recalledQueued === undefined || !("submissionId" in recalledQueued)) {
		throw new Error("The queued submission was not recalled.");
	}
	expect(recalledQueued.submissionId).toBe(queued.submissionId);
	expect(recalledQueued.messageId).toBe(queued.messageId);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		kind: "recalled",
		messageId: queued.messageId,
		reason: "recall",
		submissionId: queued.submissionId,
	});
	expect(events[0]?.turnId).toBeDefined();
	expect(userPrompts(engine.getSnapshot().transcript)).not.toContain(
		"withdraw me"
	);

	release();
	await compaction;
	await engine.internalPort.shutdown();
});

test("queues a submission that arrives while a compaction is in flight", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	const accepted = await engine.send(
		sendInput({ composition: compositionOf("queued"), userText: "queued" })
	);

	expect(accepted).toEqual({ rejected: false });
	const queued = engine.getSnapshot().queuedSubmissions;
	expect(queued.map(({ input }) => input.composition.text)).toEqual(["queued"]);
	// A Queued Submission is not a Session Record: nothing has entered the
	// Session Transcript but what the compaction already left there.
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual(
		userPrompts(compactionHistory())
	);

	release();
	await compaction;
	await runtime.started(1);
	expect(runtime.prompts).toEqual(["queued"]);
	runtime.release();

	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	expect(userPrompts(engine.getSnapshot().transcript).at(-1)).toBe("queued");
});

test("drains the Submission Queue in order, one Agent Turn at a time", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "one" }));
	await engine.send(sendInput({ userText: "two" }));
	await engine.send(sendInput({ userText: "three" }));
	expect(engine.getSnapshot().queuedSubmissions).toHaveLength(3);

	release();
	await compaction;
	await runtime.started(1);
	// The first submission runs alone; the rest still wait.
	expect(runtime.prompts).toEqual(["one"]);
	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["one", "two"]);
	runtime.release();
	await runtime.started(3);
	expect(runtime.prompts).toEqual(["one", "two", "three"]);
	runtime.release();

	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	expect(
		userPrompts(engine.getSnapshot().transcript).slice(
			userPrompts(compactionHistory()).length
		)
	).toEqual(["one", "two", "three"]);
});

test("drains submissions queued while a compaction was in flight", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	const accepted = await engine.send(sendInput({ userText: "queued" }));

	expect(accepted).toEqual({ rejected: false });
	expect(
		engine
			.getSnapshot()
			.queuedSubmissions.map(({ input }) => input.composition.text)
	).toEqual(["queued"]);
	expect(runtime.prompts).toEqual([]);

	release();
	await compaction;
	await runtime.started(1);
	// The queue waited for the compaction and then ran as its own turn.
	expect(runtime.prompts).toEqual(["queued"]);
	runtime.release();
});

test("recalls queued submissions after a failed Agent Turn", async () => {
	const failedRunStarted = Promise.withResolvers<void>();
	const failRun = Promise.withResolvers<void>();
	const recalled = Promise.withResolvers<void>();
	const queuedRunsDrained = Promise.withResolvers<void>();
	const prompts: string[] = [];
	const recalledSubmissionIds: string[] = [];
	const queuedSubmissionIds: string[] = [];
	const recalledCompositions: string[] = [];
	const recalledReasons: string[] = [];
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ messages }) => {
				prompts.push(promptOfTurn(messages));
				if (prompts.length === 1) {
					failedRunStarted.resolve();
					await failRun.promise;
					return {
						error: new Error("The model rejected the request."),
					};
				}
				if (prompts.length === 5) {
					queuedRunsDrained.resolve();
				}
				return {};
			},
		},
	});
	engine.onSubmissionEvent((event) => {
		if (event.kind !== "recalled") {
			return;
		}
		recalledSubmissionIds.push(event.submissionId);
		recalledCompositions.push(event.composition?.text ?? "");
		recalledReasons.push(event.reason ?? "");
		if (recalledSubmissionIds.length === 4) {
			recalled.resolve();
		}
	});

	try {
		const active = await engine.prompt(sendInput({ userText: "active turn" }));
		if (active.rejected) {
			throw new Error(active.reason);
		}
		await failedRunStarted.promise;

		for (const userText of ["one", "two", "three", "four"]) {
			const queued = await engine.prompt(sendInput({ userText }));
			if (queued.rejected) {
				throw new Error(queued.reason);
			}
			queuedSubmissionIds.push(queued.submissionId);
		}

		failRun.resolve();
		await Promise.race([recalled.promise, queuedRunsDrained.promise]);

		const snapshot = engine.getSnapshot();
		expect({
			prompts,
			transcript: userPrompts(snapshot.transcript),
			queued: snapshot.queuedSubmissions.map(({ input }) => input.userText),
			recalledCompositions,
			recalledCount: recalledSubmissionIds.length,
			recalledReasons,
			steering: snapshot.steeringMessages.map(({ input }) => input.userText),
		}).toEqual({
			prompts: ["active turn"],
			transcript: ["active turn"],
			queued: [],
			recalledCompositions: ["one", "two", "three", "four"],
			recalledCount: 4,
			recalledReasons: [
				"turn-failed",
				"turn-failed",
				"turn-failed",
				"turn-failed",
			],
			steering: [],
		});
		expect(recalledSubmissionIds).toEqual(queuedSubmissionIds);
	} finally {
		failRun.resolve();
		await engine.internalPort.shutdown();
	}
});

test("does not log operational cancellations as unexpected turn failures", async () => {
	await withLoggerHome(async (home) => {
		const engine = createTestAgentSession([], undefined, {
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async () => ({
					error: Object.assign(new Error("provider request cancelled"), {
						code: "cancelled",
					}),
				}),
			},
		});
		try {
			await engine.send(sendInput());
			await logger.flush();

			const failureRecords = (
				await readLoggerRecords(home).catch(() => [])
			).filter(
				({ message: recordMessage }) => recordMessage === "Agent turn failed"
			);
			expect(failureRecords).toEqual([]);
		} finally {
			await engine.internalPort.shutdown();
		}
	});
});

test("logs failed manual compactions at error severity without summary content", async () => {
	await withLoggerHome(async (home) => {
		const engine = createTestAgentSession(
			compactionHistory(),
			createCompactionModule(async () => {
				throw new Error("private summary failure");
			})
		);
		try {
			await expect(
				engine.compact({ model, trigger: "manual" })
			).rejects.toBeInstanceOf(Error);
			await logger.flush();

			const failureRecords = (await readLoggerRecords(home)).filter(
				({ message: recordMessage }) =>
					recordMessage === "Session compaction failed"
			);
			expect(failureRecords).toHaveLength(1);
			expect(failureRecords[0]).toMatchObject({
				context: {
					errorCode: "summary-failed",
					errorType: "SessionCompactionError",
					operation: "session.compaction",
					phase: "failed",
					trigger: "manual",
				},
				level: "error",
			});
			expect(JSON.stringify(failureRecords[0])).not.toContain(
				"private summary failure"
			);
		} finally {
			await engine.internalPort.shutdown();
		}
	});
});

test("drains the Submission Queue after a cancelled turn", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "one" }));
	await engine.send(sendInput({ userText: "two" }));

	release();
	await compaction;
	await runtime.started(1);
	engine.cancel();
	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["one", "two"]);

	runtime.release();
	// A cancelled turn never strands the submissions behind it.
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
});

test("interrupting an active turn recalls only uncommitted queued Submissions", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	const marked: SessionSubmissionComposition = {
		fileTokens: [{ start: 0, token: "[Image 1] " }],
		files: [],
		pastedText: [{ text: "many lines", token: "[Pasted ~9 lines]" }],
		text: "[Image 1] [Pasted ~9 lines] two",
	};
	await engine.send(sendInput({ composition: marked, userText: "two" }));
	await engine.send(
		sendInput({ composition: compositionOf("three"), userText: "three" })
	);

	const recalled = await engine.interrupt();

	expect(recalled.map(({ input }) => input.composition.text)).toEqual([
		marked.text,
		"three",
	]);
	// Only queued, uncommitted submissions return, in delivery order.
	// Recall restores the composition the message was composed with, markers and
	// pasted text included.
	expect(recalled[0]?.input.composition).toEqual(marked);
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	runtime.release();
	await first;
	// The interrupted turn delivered nothing, so its queued messages stay
	// recalled and a fresh submission runs without waiting behind them.
	expect(runtime.boundaries.map(({ delivered }) => delivered)).toEqual([[]]);
	void engine.send(sendInput({ userText: "fresh" }));
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["one", "fresh"]);

	runtime.release();
	expect(await engine.recallWaitingMessages()).toEqual([]);
});

test("commits a queue-head Submission before delivering it to the active turn", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commits: SessionRecord[] = [];
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	const accepted = await engine.send(sendInput({ userText: "correction" }));
	expect(accepted).toEqual({ rejected: false });
	expect(engine.getSnapshot().steeringMessages).toEqual([]);

	const steered = await engine.steer();
	if (steered.kind !== "steered") {
		throw new Error("The queued Submission was not committed.");
	}
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"correction",
	]);
	expect(commits[1]?.messages[0]?.metadata?.submissionStatus).toBe("pending");

	runtime.release();
	await first;

	expect(runtime.boundaries.map(({ delivered }) => delivered)).toEqual([
		["correction"],
	]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"correction",
	]);
	expect(runtime.prompts).toEqual(["one"]);
	expect(engine.getSnapshot().steeringMessages).toEqual([]);

	const opening = commits[0]?.messages[0];
	const steering = commits[1];
	expect(commits.map(({ outcome }) => outcome.kind)).toEqual([
		"user",
		"user",
		"assistant",
	]);
	expect(steering?.messages[0]?.metadata?.joinedTurnId).toBe(steering?.turnId);
	expect(runtime.boundaries[0]?.sourceUserMessageId).toBe(opening?.id);
});
test("does not acknowledge a steer when shutdown wins the durable-write race", async () => {
	const runtime = createQueuedRuntime();
	const mentionsStarted = Promise.withResolvers<void>();
	const mentions = Promise.withResolvers<[]>();
	const commits: SessionRecord[] = [];
	const events: SessionSubmissionEvent[] = [];
	let shutdown: Promise<void> | undefined;
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		resolveFileMentions: async (text) => {
			if (text === "correction") {
				mentionsStarted.resolve();
				return mentions.promise;
			}
			return [];
		},
		turnRunner: runtime.runtime,
	});
	engine.onSubmissionEvent((event) => events.push(event));

	const active = engine.send(sendInput({ userText: "active turn" }));
	let steering: Promise<unknown> | undefined;
	try {
		await runtime.started(1);
		await engine.send(sendInput({ userText: "correction" }));
		const queued = engine.getSnapshot().queuedSubmissions[0];
		if (queued === undefined) {
			throw new Error("The correction was not queued.");
		}
		const steeringOperation = engine.steer();
		steering = steeringOperation;
		await mentionsStarted.promise;

		mentions.resolve([]);
		queueMicrotask(() => {
			shutdown = engine.internalPort.shutdown();
		});
		runtime.release();

		expect(await steeringOperation).toMatchObject({
			kind: "rejected",
			messageId: queued.messageId,
		});
		if (shutdown === undefined) {
			throw new Error("Shutdown did not enter its closing phase.");
		}
		await shutdown;
		expect(
			commits.flatMap(({ messages }) =>
				messages.filter(({ id }) => id === queued.messageId)
			)
		).toHaveLength(0);
		expect(
			events.filter(
				(event) =>
					event.kind === "steered" && event.messageId === queued.messageId
			)
		).toHaveLength(0);
	} finally {
		mentions.resolve([]);
		runtime.release();
		shutdown ??= engine.internalPort.shutdown();
		await steering?.catch(() => undefined);
		await shutdown;
		await active.catch(() => undefined);
	}
});
test("shutdown defers queued attachment cleanup until steering commit settles", async () => {
	for (const failCommit of [false, true]) {
		const suffix = failCommit ? "failed" : "committed";
		const headId = attachmentId(`shutdown-head-${suffix}`);
		const laterId = attachmentId(`shutdown-later-${suffix}`);
		const headFile = fromPartial<SessionFilePart>({
			attachmentId: headId,
			mediaType: "image/png",
			type: "file",
			url: `attachment://${headId}`,
		});
		const laterFile = fromPartial<SessionFilePart>({
			attachmentId: laterId,
			mediaType: "image/png",
			type: "file",
			url: `attachment://${laterId}`,
		});
		const runtime = createQueuedRuntime();
		const commitStarted = Promise.withResolvers<void>();
		const releaseCommit = Promise.withResolvers<void>();
		const retained: string[] = [];
		const released: string[] = [];
		const engine = createTestAgentSession([], undefined, {
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (ids) => released.push(...ids),
				retain: (ids) => retained.push(...ids),
			},
			commitRecord: async ({ record }) => {
				if (
					record.outcome.kind !== "user" ||
					record.messages[0]?.metadata?.joinedTurnId === undefined
				) {
					return;
				}
				commitStarted.resolve();
				await releaseCommit.promise;
				if (failCommit) {
					throw new Error("The steering record could not be saved.");
				}
			},
			turnRunner: runtime.runtime,
		});
		const active = engine.send(sendInput({ userText: "active turn" }));
		let steering: Promise<unknown> | undefined;
		let shutdown: Promise<void> | undefined;

		try {
			await runtime.started(1);
			await engine.send(
				sendInput({
					composition: compositionOf("first correction", [headFile]),
					files: [headFile],
					userText: "first correction",
				})
			);
			await engine.send(
				sendInput({
					composition: compositionOf("later correction", [laterFile]),
					files: [laterFile],
					userText: "later correction",
				})
			);
			steering = engine.steer();
			await commitStarted.promise;

			shutdown = engine.internalPort.shutdown();
			releaseCommit.resolve();
			runtime.release();
			if (failCommit) {
				expect(await steering).toMatchObject({ kind: "rejected" });
			} else {
				expect(await steering).toMatchObject({ kind: "steered" });
			}
			await shutdown;
			await active;

			expect(retained).toEqual([headId, laterId]);
			expect(released).toEqual([headId, laterId]);
			expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
			expect(engine.getSnapshot().steeringMessages).toMatchObject(
				failCommit
					? []
					: [
							{
								input: { userText: "first correction" },
								status: "pending",
							},
						]
			);
		} finally {
			releaseCommit.resolve();
			runtime.release();
			shutdown ??= engine.internalPort.shutdown();
			await steering?.catch(() => undefined);
			await shutdown;
			await active.catch(() => undefined);
		}
	}
});

test("applies the resolved attachment budget across a steering boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-steering-budget-"));
	const store = createSessionAttachmentStore({
		repository: createMemoryAttachmentMetadataRepository(),
		root,
	});
	const runtime = createQueuedRuntime({ boundary: true });
	const files = await Promise.all(
		Array.from({ length: 5 }, async (_, index) => {
			const reference = await store.ingest({
				bytes: new Uint8Array([...PNG_BYTES, index]),
				filename: `image-${index}.png`,
				mediaType: "image/png",
			});
			return attachmentReferenceToFilePart(reference);
		})
	);
	const engine = createTestAgentSession([], undefined, {
		attachments: {
			externalize: async (messages) => [...messages],
			hydrate: ({
				budget,
				failOnMissingAttachments,
				messages,
				priorityMessageId,
				signal,
			}) =>
				store.hydrateMessages(messages, {
					...budget,
					...(failOnMissingAttachments ? { failOnMissing: true } : {}),
					priorityMessageId,
					purpose: "model",
					signal,
				}),
			release: () => undefined,
			retain: () => undefined,
		},
		resolveCompactionSettings: async () =>
			fromPartial<ResolvedCompactionSettings>({
				autoAvailable: false,
				enabled: true,
				maxMediaAttachments: 3,
				maxMediaBytes: 1024,
				maxMediaTokens: 10_000,
			}),
		turnRunner: runtime.runtime,
	});

	const active = engine.send(sendInput({ userText: "active turn" }));
	try {
		await runtime.started(1);
		await engine.send(
			sendInput({
				composition: compositionOf("first correction", files),
				files,
				userText: "first correction",
			})
		);
		await engine.steer();
		await engine.send(
			sendInput({
				composition: compositionOf("second correction", files),
				files,
				userText: "second correction",
			})
		);
		await engine.steer();

		runtime.release();
		await active;

		const delivered = runtime.boundaries[0]?.delivered ?? [];
		expect(
			delivered.filter(
				(text) => text === "first correction" || text === "second correction"
			)
		).toEqual(["first correction", "second correction"]);
		expect(
			delivered.filter((text) =>
				text.startsWith("[Attachment payload omitted:")
			)
		).toHaveLength(7);
		expect(runtime.boundaries[0]?.hydratedAttachmentCount).toBe(3);
	} finally {
		runtime.release();
		await engine.internalPort.shutdown();
		await active.catch(() => undefined);
		await rm(root, { force: true, recursive: true });
	}
});

test("blocks later steering when an accepted attachment is unavailable", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const missingError = "One or more attachments are unavailable.";
	const missingMessageId = sessionMessageId("missing-attachment-steer");
	const laterMessageId = sessionMessageId("later-steer");
	const fileId = attachmentId(`v1-${"a".repeat(64)}`);
	const unavailableFile = fromPartial<SessionFilePart>({
		attachmentId: fileId,
		byteLength: 256,
		filename: "missing.png",
		mediaType: "image/png",
		type: "file",
		url: `attachment://${fileId}`,
	});
	const events: SessionSubmissionEvent[] = [];
	const engine = createTestAgentSession([], undefined, {
		attachments: {
			externalize: async (messages) => [...messages],
			hydrate: async ({ failOnMissingAttachments, messages }) => {
				if (failOnMissingAttachments) {
					throw new Error(missingError);
				}
				return [...messages];
			},
			release: () => undefined,
			retain: () => undefined,
		},
		turnRunner: runtime.runtime,
	});
	engine.onSubmissionEvent((event) => events.push(event));

	const active = engine.send(sendInput({ userText: "active turn" }));
	await runtime.started(1);
	await engine.send(
		sendInput({
			composition: compositionOf("[Image 1]", [unavailableFile]),
			files: [unavailableFile],
			messageId: missingMessageId,
			userText: "[Image 1]",
		})
	);
	await engine.steer();
	await engine.send(
		sendInput({ messageId: laterMessageId, userText: "later correction" })
	);
	await engine.steer();

	runtime.release();
	await active;

	expect(runtime.boundaries[0]?.delivered).toEqual([]);
	expect(
		engine.getSnapshot().steeringMessages.map(({ message, status }) => ({
			messageId: message.id,
			status,
		}))
	).toEqual([
		{ messageId: missingMessageId, status: "failed" },
		{ messageId: laterMessageId, status: "pending" },
	]);
	expect(events.filter((event) => event.kind === "failed")).toMatchObject([
		{
			kind: "failed",
			messageId: missingMessageId,
			reason: missingError,
		},
	]);
});
test("rejects committed fallback when an accepted attachment is unavailable", async () => {
	const runtime = createQueuedRuntime();
	const missingError = "One or more attachments are unavailable.";
	const missingMessageId = sessionMessageId("missing-fallback-attachment");
	const fileId = attachmentId(`v1-${"a".repeat(64)}`);
	const unavailableFile = fromPartial<SessionFilePart>({
		attachmentId: fileId,
		byteLength: 256,
		filename: "missing.png",
		mediaType: "image/png",
		type: "file",
		url: `attachment://${fileId}`,
	});
	const checkedHydration = Promise.withResolvers<boolean>();
	const failedSteering = Promise.withResolvers<void>();
	const events: SessionSubmissionEvent[] = [];
	const engine = createTestAgentSession([], undefined, {
		attachments: {
			externalize: async (messages) => [...messages],
			hydrate: async ({ failOnMissingAttachments, messages }) => {
				if (messages.some(({ id }) => id === missingMessageId)) {
					const strict = failOnMissingAttachments === true;
					checkedHydration.resolve(strict);
					if (strict) {
						throw new Error(missingError);
					}
				}
				return [...messages];
			},
			release: () => undefined,
			retain: () => undefined,
		},
		turnRunner: runtime.runtime,
	});
	engine.onSubmissionEvent((event) => {
		events.push(event);
		if (event.kind === "failed" && event.messageId === missingMessageId) {
			failedSteering.resolve();
		}
	});

	const active = engine.send(sendInput({ userText: "active turn" }));
	await runtime.started(1);
	await engine.send(
		sendInput({
			composition: compositionOf("[Image 1]", [unavailableFile]),
			files: [unavailableFile],
			messageId: missingMessageId,
			userText: "[Image 1]",
		})
	);
	expect((await engine.steer()).kind).toBe("steered");

	runtime.release();
	const strict = await checkedHydration.promise;
	if (!strict) {
		await runtime.started(2);
		runtime.release();
	}
	await active;

	expect(strict).toBe(true);
	await failedSteering.promise;
	expect(runtime.prompts).toEqual(["active turn"]);
	expect(
		engine
			.getSnapshot()
			.steeringMessages.map(({ message, reason, status }) => ({
				messageId: message.id,
				reason,
				status,
			}))
	).toEqual([
		{
			messageId: missingMessageId,
			reason: missingError,
			status: "failed",
		},
	]);
	const failedEvents = events.filter(
		(event) => event.kind === "failed" && event.messageId === missingMessageId
	);
	expect(failedEvents).toHaveLength(1);
	expect(failedEvents[0]).toMatchObject({
		kind: "failed",
		messageId: missingMessageId,
		reason: missingError,
	});
});

test("preserves FIFO when committed Steering delivery fails without replaying later queued input", async () => {
	const turnStarted = Promise.withResolvers<void>();
	const allowBoundary = Promise.withResolvers<void>();
	const prompts: string[] = [];
	const failures: string[] = [];
	const observedEvents: SessionSubmissionEvent[] = [];
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, messages, takeSteeringMessages }) => {
				prompts.push(promptOfTurn(messages));
				turnStarted.resolve();
				await allowBoundary.promise;
				expect(userPrompts(await takeSteeringMessages())).toEqual([
					"correction",
					"second correction",
				]);
				await callbacks.onTerminal(
					fromPartial<AgentTurnTerminalEvent>({
						failure: { message: "The model rejected the next step." },
						sequence: 2,
						turnId: execution.turnId,
						type: "agent-turn-failed",
					})
				);
				return { error: new Error("The model rejected the next step.") };
			},
		},
	});
	engine.onSubmissionEvent((event) => {
		observedEvents.push(event);
		if (event.kind === "failed") {
			failures.push(event.reason ?? "unspecified");
		}
	});

	try {
		const active = engine.send(sendInput({ userText: "active turn" }));
		await turnStarted.promise;
		await engine.send(sendInput({ userText: "correction" }));
		expect((await engine.steer()).kind).toBe("steered");
		await engine.send(sendInput({ userText: "second correction" }));
		expect((await engine.steer()).kind).toBe("steered");
		await engine.send(sendInput({ userText: "later" }));
		const laterSubmission = engine.getSnapshot().queuedSubmissions[0];
		if (laterSubmission === undefined) {
			throw new Error("The later input was not queued.");
		}
		allowBoundary.resolve();
		await active;

		expect(prompts).toEqual(["active turn"]);
		expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
			"active turn",
			"correction",
			"second correction",
		]);
		expect(userPrompts(engine.getSnapshot().context)).not.toContain(
			"correction"
		);
		const failedSteering = engine.getSnapshot().steeringMessages;
		expect(failedSteering.map(({ input }) => input.userText)).toEqual([
			"correction",
			"second correction",
		]);
		expect(failedSteering.map(({ status }) => status)).toEqual([
			"failed",
			"failed",
		]);
		// Existing failure handling recalls uncommitted work rather than replaying it.
		expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
		expect(
			observedEvents.filter(
				({ submissionId }) => submissionId === laterSubmission.submissionId
			)
		).toMatchObject([{ kind: "recalled", reason: "turn-failed" }]);
		expect(failures).toEqual([
			"The model rejected the next step.",
			"The model rejected the next step.",
		]);
		expect(engine.continue()).toMatchObject({ kind: "rejected" });
	} finally {
		allowBoundary.resolve();
		await engine.internalPort.shutdown();
	}
});
test("fails a committed Submission when Agent Turn setup errors before terminal", async () => {
	const activeTurnStarted = Promise.withResolvers<void>();
	const releaseActiveTurn = Promise.withResolvers<void>();
	const failedTurnStarted = Promise.withResolvers<void>();
	const failure = "The Host could not construct the Agent prompt.";
	let runCount = 0;
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution }) => {
				runCount += 1;
				if (runCount > 1) {
					failedTurnStarted.resolve();
					return { error: new Error(failure) };
				}
				activeTurnStarted.resolve();
				await releaseActiveTurn.promise;
				await callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						messages: [
							{
								id: sessionMessageId(`assistant-${execution.turnId}`),
								parts: [{ text: "answer", type: "text" }],
								role: "assistant",
							},
						],
						outcome: {
							kind: "assistant",
							terminal: { finishedAt: 2, kind: "completed" },
						},
						turnId: execution.turnId,
					})
				);
				await callbacks.onTerminal({
					finishedAt: 2,
					sequence: 2,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
	});
	const events: SessionSubmissionEvent[] = [];
	engine.onSubmissionEvent((event) => events.push(event));
	const active = engine.send(sendInput({ userText: "active turn" }));

	try {
		await activeTurnStarted.promise;
		await engine.send(sendInput({ userText: "committed correction" }));
		expect((await engine.steer()).kind).toBe("steered");
		const committed = engine.getSnapshot().steeringMessages[0];
		if (committed === undefined) {
			throw new Error("The steering Submission was not committed.");
		}

		releaseActiveTurn.resolve();
		await active;
		await failedTurnStarted.promise;
		for (
			let attempt = 0;
			engine.internalPort.hasPendingWork() && attempt < 100;
			attempt += 1
		) {
			await Bun.sleep(0);
		}

		expect(engine.internalPort.hasPendingWork()).toBe(false);
		expect(engine.getSnapshot().steeringMessages).toMatchObject([
			{
				input: { userText: "committed correction" },
				message: { metadata: { submissionStatus: "failed" } },
				reason: failure,
				status: "failed",
			},
		]);
		expect(
			events.filter(
				(event) =>
					event.kind === "failed" && event.messageId === committed.message.id
			)
		).toMatchObject([{ kind: "failed", reason: failure }]);
	} finally {
		releaseActiveTurn.resolve();
		await engine.internalPort.shutdown();
		await active.catch(() => undefined);
	}
});

test("marks delivered steering failed when its active turn is interrupted", async () => {
	const turnStarted = Promise.withResolvers<void>();
	const allowBoundary = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const allowTurnEnd = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ takeSteeringMessages }) => {
				turnStarted.resolve();
				await allowBoundary.promise;
				expect(userPrompts(await takeSteeringMessages())).toEqual([
					"committed correction",
				]);
				delivered.resolve();
				await allowTurnEnd.promise;
				return { error: new Error("The interrupted model request ended.") };
			},
		},
	});
	const active = engine.send(sendInput({ userText: "active turn" }));

	try {
		await turnStarted.promise;
		await engine.send(sendInput({ userText: "committed correction" }));
		expect((await engine.steer()).kind).toBe("steered");
		allowBoundary.resolve();
		await delivered.promise;

		expect(
			engine.getSnapshot().transcript.at(-1)?.metadata?.submissionStatus
		).toBe("processing");
		await engine.interrupt();
		allowTurnEnd.resolve();
		await active;

		expect(engine.getSnapshot().steeringMessages).toMatchObject([
			{
				input: { userText: "committed correction" },
				message: { metadata: { submissionStatus: "failed" } },
				status: "failed",
			},
		]);
	} finally {
		allowBoundary.resolve();
		allowTurnEnd.resolve();
		await active;
		await engine.internalPort.shutdown();
	}
});

test("logs failed Steering checkpoints without Steering content", async () => {
	await withLoggerHome(async (home) => {
		const runtime = createQueuedRuntime({ boundary: true });
		const engine = createTestAgentSession([], undefined, {
			commitRecord: async ({ record }) => {
				const committed = record.messages[0];
				if (
					record.outcome.kind === "user" &&
					committed?.metadata?.joinedTurnId !== undefined
				) {
					throw Object.assign(new Error("private steering detail"), {
						code: "STEERING_WRITE_FAILED",
					});
				}
			},
			turnRunner: runtime.runtime,
		});
		try {
			const first = engine.send(sendInput({ userText: "opening prompt" }));
			await runtime.started(1);
			await engine.send(sendInput({ userText: "private steering text" }));
			expect(await engine.steer()).toMatchObject({
				kind: "rejected",
				reason: "Could not durably commit the Submission.",
			});
			await engine.recallWaitingMessages();
			runtime.release();
			await first;

			await logger.flush();
			const records = await readLoggerRecords(home);
			const persistenceRecords = records.filter(
				({ message }) => message === "Steering message persistence failed"
			);
			expect(persistenceRecords).toHaveLength(1);
			expect(persistenceRecords[0]).toMatchObject({
				context: {
					errorCode: "STEERING_WRITE_FAILED",
					errorType: "Error",
					operation: "session.steering",
					phase: "persistence",
					turnId: expect.any(String),
				},
				level: "error",
			});
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				"private steering detail"
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				"private steering text"
			);
		} finally {
			await engine.internalPort.shutdown();
		}
	});
});

test("waits for a steering commit before shutdown settles", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commitStarted = Promise.withResolvers<void>();
	const allowCommit = Promise.withResolvers<void>();
	let steeringCommitted = false;
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			const message = record.messages[0];
			if (
				record.outcome.kind === "user" &&
				message?.metadata?.joinedTurnId !== undefined
			) {
				commitStarted.resolve();
				await allowCommit.promise;
				steeringCommitted = true;
			}
		},
		turnRunner: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "correction" }));
	const steering = engine.steer();
	await commitStarted.promise;
	const shutdown = engine.internalPort.shutdown();
	runtime.release();
	const probe = Promise.withResolvers<"probe">();
	queueMicrotask(() => probe.resolve("probe"));
	const result = await Promise.race([
		shutdown.then(() => "shutdown" as const),
		probe.promise,
	]);

	allowCommit.resolve();
	await shutdown;
	await first;
	expect(result).toBe("probe");
	expect(await steering).toMatchObject({ kind: "steered" });
	expect(steeringCommitted).toBe(true);
});

test("delivers Steering Messages in the order they were accepted", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "two" }));
	await engine.send(sendInput({ userText: "three" }));
	expect((await engine.steer()).kind).toBe("steered");
	expect((await engine.steer()).kind).toBe("steered");

	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.userText)
	).toEqual(["two", "three"]);

	runtime.release();
	await first;

	expect(runtime.boundaries.map(({ delivered }) => delivered)).toEqual([
		["two", "three"],
	]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"two",
		"three",
	]);
});

test("keeps the Model Target of the turn a Steering Message joined", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commits: SessionRecord[] = [];
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: runtime.runtime,
	});
	const otherModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	// The composer's selection changes while the turn runs: the correction still
	// joins the turn on the Model Target that turn already runs with.
	await engine.send(sendInput({ model: otherModel, userText: "correction" }));
	expect((await engine.steer()).kind).toBe("steered");

	runtime.release();
	await first;

	// The turn ran on its own Model Target, and the delivered message records
	// that same one rather than the composer's newer selection.
	expect(runtime.targets).toEqual([
		{ model, effort: undefined, reasoningMode: undefined },
	]);
	expect(commits[1]?.messages[0]?.metadata?.model).toEqual(model);
});

test("runs a committed Submission in a new turn when the active run has no safe boundary", async () => {
	// This fake runtime does not call its safe-boundary callback.
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "correction" }));
	expect((await engine.steer()).kind).toBe("steered");

	runtime.release();
	await runtime.started(2);

	// The committed Submission remains unread until the active turn ends, then
	// becomes the next Agent Turn's opening user message.
	const pendingMessage = engine
		.getSnapshot()
		.context.findLast(({ role }) => role === "user");
	expect(pendingMessage?.metadata?.submissionStatus).toBe("processing");
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(runtime.prompts).toEqual(["one", "correction"]);
	runtime.release();
	await first;

	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"correction",
	]);
});

test("keeps the active Model Target when a committed Submission falls back to a new turn", async () => {
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
	const otherModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ model: otherModel, userText: "correction" }));
	expect((await engine.steer()).kind).toBe("steered");

	runtime.release();
	await runtime.started(2);

	// The new turn uses the Model Target that committed the Submission, not the
	// composer's changed selection.
	expect(runtime.targets).toEqual([
		{ model, effort: undefined, reasoningMode: undefined },
		{ model, effort: undefined, reasoningMode: undefined },
	]);
	runtime.release();
	await first;
});

test("prioritizes a committed queue head over later queued work", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "queued-first" }));
	await engine.send(sendInput({ userText: "queued-second" }));
	release();
	await compaction;
	await runtime.started(1);
	await engine.send(sendInput({ userText: "steer" }));
	expect((await engine.steer()).kind).toBe("steered");

	runtime.release();
	await runtime.started(2);
	runtime.release();
	await runtime.started(3);

	// The committed queue head runs before the later uncommitted queue entry.
	expect(runtime.prompts).toEqual(["queued-first", "queued-second", "steer"]);
	runtime.release();
});

test("recalls part of the queue by identifier and ignores an unknown one", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);

	// The submissions are accepted while a compaction holds the lane — the
	// session is busy without a running Agent Turn — so they queue.
	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "two" }));
	await engine.send(sendInput({ userText: "three" }));
	const waiting = engine.getSnapshot().queuedSubmissions;
	const second = waiting[0]?.id ?? queuedSubmissionId("missing");
	const third = waiting[1]?.id ?? queuedSubmissionId("missing");

	expect(
		(await engine.recallWaitingMessages([second])).map(
			({ input }) => input.composition.text
		)
	).toEqual(["two"]);
	expect(engine.getSnapshot().queuedSubmissions.map(({ id }) => id)).toEqual([
		third,
	]);
	// An identifier that names nothing waiting changes nothing.
	expect(await engine.recallWaitingMessages([second])).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions.map(({ id }) => id)).toEqual([
		third,
	]);

	release();
	await compaction;
	await runtime.started(1);
	// Only the submission that was left behind runs.
	expect(runtime.prompts).toEqual(["three"]);
	runtime.release();
});

test("recall and interrupt withdraw the queue tail before steering drains it", async () => {
	const summaryStarted = Promise.withResolvers<void>();
	const steeringRecordStarted = Promise.withResolvers<void>();
	const allowSteeringRecord = Promise.withResolvers<void>();
	const steeringRunStarted = Promise.withResolvers<void>();
	const allowSteeringRun = Promise.withResolvers<void>();
	const runPrompts: string[][] = [];
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(async ({ signal }) => {
			summaryStarted.resolve();
			const { promise, reject } = Promise.withResolvers<{ text: string }>();
			const cancel = () => reject(new Error("summary cancelled"));
			if (signal?.aborted) {
				cancel();
			} else {
				signal?.addEventListener("abort", cancel, { once: true });
			}
			return promise;
		}),
		{
			commitRecord: async ({ record }) => {
				if (record.outcome.kind === "user") {
					steeringRecordStarted.resolve();
					await allowSteeringRecord.promise;
				}
			},
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async (request) => {
					reportTurnStarted(request);
					runPrompts.push(userPrompts(request.messages));
					steeringRunStarted.resolve();
					await allowSteeringRun.promise;
					await request.callbacks.onTerminal(
						fromPartial<AgentTurnTerminalEvent>({
							finishedAt: 2,
							sequence: 2,
							turnId: request.execution.turnId,
							type: "agent-turn-completed",
							usage: { inputTokens: 1, outputTokens: 1 },
						})
					);
					return {};
				},
			},
		}
	);
	const compaction = engine.compact({ model, trigger: "manual" });
	let recall: Promise<SessionWaitingMessage[]> | undefined;
	let steering: Promise<SessionSteeringAdmission> | undefined;
	let interruption: Promise<SessionInterruptResult> | undefined;

	try {
		await summaryStarted.promise;
		await engine.send(sendInput({ userText: "first" }));
		await engine.send(sendInput({ userText: "second" }));
		await engine.send(sendInput({ userText: "third" }));
		const second = engine.getSnapshot().queuedSubmissions[1];
		if (second === undefined) {
			throw new Error("The second queued Submission was not accepted.");
		}
		const recallPromise = engine.recallWaitingMessages([second.id]);
		recall = recallPromise;
		const steeringPromise = engine.steer();
		steering = steeringPromise;
		await steeringRecordStarted.promise;
		const interruptionPromise = engine.interruptAll();
		interruption = interruptionPromise;
		await expect(compaction).rejects.toMatchObject({ code: "cancelled" });

		allowSteeringRecord.resolve();
		const steeringResult = await steeringPromise;
		if (steeringResult.kind !== "steered") {
			throw new Error("The queue-head Submission was not committed.");
		}
		const recalledSecond = await recallPromise;
		const interrupted = await interruptionPromise;
		await steeringRunStarted.promise;

		expect(recalledSecond.map(({ input }) => input.composition.text)).toEqual([
			"second",
		]);
		expect(interrupted.kind).toBe("compaction");
		expect(
			interrupted.recalled.map(({ input }) => input.composition.text)
		).toEqual(["third"]);
		expect(runPrompts).toHaveLength(1);
		expect(runPrompts[0]?.at(-1)).toBe("first");
		expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
		expect(
			engine
				.getSnapshot()
				.transcript.find(({ id }) => id === steeringResult.messageId)?.metadata
				?.submissionStatus
		).toBe("processing");
	} finally {
		allowSteeringRecord.resolve();
		await recall?.catch(() => undefined);
		allowSteeringRun.resolve();
		await steering?.catch(() => undefined);
		await interruption?.catch(() => undefined);
		await engine.internalPort.shutdown();
	}
});

test("runs a queued submission with the Model Target selection it was accepted with", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);
	const queuedModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ model: queuedModel, userText: "two" }));

	release();
	await compaction;
	await runtime.started(1);
	// The selection the submission was accepted with is the one that runs, even
	// though the session's own selection could change while it waits.
	expect(runtime.targets).toEqual([
		{ model: queuedModel, effort: undefined, reasoningMode: undefined },
	]);

	runtime.release();
});

test("steers the Agent Turn started by overflow context continuation", async () => {
	const gates: Array<() => void> = [];
	const prompts: string[] = [];
	const delivered: string[][] = [];
	const continuationStarted = Promise.withResolvers<void>();
	const boundaryReached = Promise.withResolvers<void>();
	const engine = createTestAgentSession(compactionHistory(), undefined, {
		resolveCompactionSettings: async () => overflowRecoverySettings(),
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, messages, takeSteeringMessages }) => {
				prompts.push(promptOfTurn(messages));
				callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				if (prompts.length === 1) {
					return { error: overflowFailure() };
				}
				continuationStarted.resolve();
				const gate = Promise.withResolvers<void>();
				gates.push(gate.resolve);
				await gate.promise;
				delivered.push(userPrompts(await takeSteeringMessages()));
				boundaryReached.resolve();
				await callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						messages: [
							{
								id: sessionMessageId(`assistant-${execution.turnId}`),
								parts: [{ text: "answer", type: "text" }],
								role: "assistant",
							},
						],
						outcome: {
							kind: "assistant",
							terminal: { finishedAt: 2, kind: "completed" },
						},
						turnId: execution.turnId,
					})
				);
				callbacks.onTerminal({
					finishedAt: 2,
					sequence: 2,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
	});

	const send = engine.send(sendInput({ userText: "first" }));
	// Recovery continues from the compacted Session Context; it does not add
	// another user message to the Submission Queue or Transcript.
	await continuationStarted.promise;
	const accepted = await engine.send(sendInput({ userText: "second" }));
	expect(accepted).toEqual({ rejected: false });
	expect((await engine.steer()).kind).toBe("steered");

	// The context continuation is the active turn, so steering adds a durable
	// user record without opening or changing the turn.
	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.userText)
	).toEqual(["second"]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	gates.shift()?.();
	await boundaryReached.promise;
	await send;
	// The continuation delivers the correction at its Model Step boundary.
	expect(delivered).toEqual([["second"]]);
	expect(prompts).toEqual(["first", "first"]);
	expect(userPrompts(engine.getSnapshot().transcript).at(-1)).toBe("second");
});

test("retains committed steering through context-overflow continuation", async () => {
	const initialTurnStarted = Promise.withResolvers<void>();
	const allowOverflow = Promise.withResolvers<void>();
	const continuationFinished = Promise.withResolvers<void>();
	const delivered: string[][] = [];
	const continuationMessages: string[][] = [];
	let runCount = 0;
	const engine = createOverflowTestSession(compactionHistory(), {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				reportTurnStarted(request);
				if (runCount === 1) {
					initialTurnStarted.resolve();
					await allowOverflow.promise;
					expect(userPrompts(await request.takeSteeringMessages())).toEqual([
						"correction",
					]);
					await request.callbacks.onTerminal(
						fromPartial<AgentTurnTerminalEvent>({
							failure: overflowOperationalFailure(),
							finishedAt: 2,
							sequence: 2,
							turnId: request.execution.turnId,
							type: "agent-turn-failed",
						})
					);
					return { error: overflowFailure() };
				}
				continuationMessages.push(userPrompts(request.messages));
				delivered.push(userPrompts(await request.takeSteeringMessages()));
				await request.callbacks.onTerminal(
					fromPartial<AgentTurnTerminalEvent>({
						finishedAt: 2,
						sequence: 2,
						turnId: request.execution.turnId,
						type: "agent-turn-completed",
						usage: { inputTokens: 1, outputTokens: 1 },
					})
				);
				continuationFinished.resolve();
				return {};
			},
		},
	});
	const active = engine.send(sendInput({ userText: "original request" }));

	try {
		await initialTurnStarted.promise;
		await engine.send(sendInput({ userText: "correction" }));
		expect((await engine.steer()).kind).toBe("steered");
		allowOverflow.resolve();
		await active;
		await continuationFinished.promise;
		await engine.internalPort.shutdown();

		expect(runCount).toBe(2);
		expect(
			[...(continuationMessages[0] ?? []), ...(delivered[0] ?? [])].filter(
				(prompt) => prompt === "correction"
			)
		).toHaveLength(1);
		const correction = engine
			.getSnapshot()
			.transcript.find(
				({ role, parts }) =>
					role === "user" &&
					parts.some(
						(part) => part.type === "text" && part.text === "correction"
					)
			);
		expect(correction?.metadata?.submissionStatus).toBe("processed");
		expect(
			engine.getSnapshot().compactions.map(({ trigger }) => trigger)
		).toEqual(["overflow"]);
		expect(engine.getSnapshot().steeringMessages).toEqual([]);
	} finally {
		allowOverflow.resolve();
		await active;
		await engine.internalPort.shutdown();
	}
});

test("fails delivered steering when overflow recovery is refused", async () => {
	const initialTurnStarted = Promise.withResolvers<void>();
	const allowOverflow = Promise.withResolvers<void>();
	const steeringFailed = Promise.withResolvers<void>();
	const correctionId = sessionMessageId("overflow-refused-correction");
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => ({
			...overflowRecoverySettings(),
			overflowRecoveryAvailable: false,
		}),
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				reportTurnStarted(request);
				initialTurnStarted.resolve();
				await allowOverflow.promise;
				expect(userPrompts(await request.takeSteeringMessages())).toEqual([
					"correction",
				]);
				await request.callbacks.onTerminal(
					fromPartial<AgentTurnTerminalEvent>({
						failure: overflowOperationalFailure(),
						finishedAt: 2,
						sequence: 2,
						turnId: request.execution.turnId,
						type: "agent-turn-failed",
					})
				);
				return { error: overflowFailure() };
			},
		},
	});
	engine.onSubmissionEvent((event) => {
		if (event.kind === "failed" && event.messageId === correctionId) {
			steeringFailed.resolve();
		}
	});
	const active = engine.send(sendInput({ userText: "original request" }));

	try {
		await initialTurnStarted.promise;
		await engine.send(
			sendInput({
				messageId: correctionId,
				userText: "correction",
			})
		);
		expect((await engine.steer()).kind).toBe("steered");
		allowOverflow.resolve();
		await active;
		await steeringFailed.promise;

		expect(engine.getSnapshot().steeringMessages).toMatchObject([
			{
				message: {
					id: correctionId,
					metadata: { submissionStatus: "failed" },
				},
				reason: "The model context is too large.",
				status: "failed",
			},
		]);
	} finally {
		allowOverflow.resolve();
		await active;
		await engine.internalPort.shutdown();
	}
});

test("does not recover a context overflow after a completed Tool Call", async () => {
	const toolId = toolCallId("overflow-completed-tool");
	let turnStarted = false;
	let recoveryTargetRequested = false;
	const engine = createOverflowTestSession([], {
		resolveCompactionSettings: async () => {
			if (turnStarted) {
				recoveryTargetRequested = true;
			}
			return overflowRecoverySettings();
		},
		turnRunner: {
			...overflowTurnRunner,
			run: async (request) => {
				turnStarted = true;
				reportTurnStarted(request);
				request.callbacks.onEvent({
					input: { path: "file.txt" },
					sequence: 1,
					toolCallId: toolId,
					toolName: "read",
					turnId: request.execution.turnId,
					type: "tool-call-started",
				});
				request.callbacks.onEvent({
					outcome: {
						output: { content: "completed side effect" },
						type: "success",
					},
					sequence: 2,
					toolCallId: toolId,
					toolName: "read",
					turnId: request.execution.turnId,
					type: "tool-call-finished",
				});
				return { error: overflowFailure() };
			},
		},
	});

	await expect(
		engine.send(sendInput({ userText: "read a file" }))
	).resolves.toEqual({ rejected: false });

	const completedTool = engine
		.getSnapshot()
		.context.flatMap(({ parts }) => parts)
		.find((part) => part.type === "tool-read" && part.toolCallId === toolId);
	expect(completedTool).toMatchObject({
		state: "output-available",
		toolCallId: toolId,
	});
	expect(recoveryTargetRequested).toBe(false);
	expect(engine.getSnapshot().compactions).toEqual([]);
	await engine.internalPort.shutdown();
});

test("does not run overflow recovery for an unrelated runtime failure", async () => {
	let turnStarted = false;
	let recoveryTargetRequested = false;
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => {
			if (turnStarted) {
				recoveryTargetRequested = true;
			}
			return overflowRecoverySettings();
		},
		turnRunner: {
			...overflowTurnRunner,
			run: async (request) => {
				turnStarted = true;
				reportTurnStarted(request);
				return { error: new Error("authentication failed") };
			},
		},
	});

	await expect(
		engine.send(sendInput({ userText: "original request" }))
	).resolves.toEqual({ rejected: false });

	expect(engine.getSnapshot().error?.message).toBe("authentication failed");
	expect(recoveryTargetRequested).toBe(false);
	expect(engine.getSnapshot().compactions).toEqual([]);
	await engine.internalPort.shutdown();
});
test("keeps an overflow retryable when recovery is unavailable for its target", async () => {
	const continuationStarted = Promise.withResolvers<void>();
	const allowContinuation = Promise.withResolvers<void>();
	let recoveryAvailable = false;
	let runCount = 0;
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => ({
			...overflowRecoverySettings(),
			overflowRecoveryAvailable: recoveryAvailable,
		}),
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				reportTurnStarted(request);
				if (runCount < 3) {
					return { error: overflowFailure() };
				}
				continuationStarted.resolve();
				await allowContinuation.promise;
				await completeRuntimeTurn(request);
				return {};
			},
		},
	});

	try {
		await engine.send(sendInput({ userText: "original request" }));
		const originalMessage = engine
			.getSnapshot()
			.context.findLast(({ role }) => role === "user");
		if (originalMessage === undefined) {
			throw new Error("The first prompt was not stored.");
		}
		expect(engine.getSnapshot().compactions).toEqual([]);

		recoveryAvailable = true;
		await engine.send(
			sendInput({ messageId: originalMessage.id, userText: undefined })
		);
		await continuationStarted.promise;

		expect(
			engine.getSnapshot().compactions.map(({ trigger }) => trigger)
		).toEqual(["overflow"]);
	} finally {
		allowContinuation.resolve();
		await engine.internalPort.shutdown();
	}
});
test("does not retry an overflow recovery that overflows during continuation", async () => {
	const continuationStarted = Promise.withResolvers<void>();
	const allowContinuation = Promise.withResolvers<void>();
	const queuedTurnStarted = Promise.withResolvers<void>();
	const recalled = Promise.withResolvers<void>();
	const recalledCompositions: string[] = [];
	const prompts: string[] = [];
	let runCount = 0;
	const engine = createOverflowTestSession(compactionHistory(), {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				prompts.push(promptOfTurn(request.messages));
				reportTurnStarted(request);
				if (runCount === 1) {
					return { error: overflowFailure() };
				}
				if (runCount === 2) {
					continuationStarted.resolve();
					await allowContinuation.promise;
					return { error: overflowFailure() };
				}
				queuedTurnStarted.resolve();
				return {};
			},
		},
	});
	engine.onSubmissionEvent((event) => {
		if (event.kind !== "recalled" || event.reason !== "turn-failed") {
			return;
		}
		recalledCompositions.push(event.composition?.text ?? "");
		recalled.resolve();
	});
	const firstSend = engine.send(sendInput({ userText: "original request" }));

	try {
		await continuationStarted.promise;
		await expect(
			engine.send(sendInput({ userText: "next request" }))
		).resolves.toEqual({ rejected: false });
		allowContinuation.resolve();
		await Promise.race([recalled.promise, queuedTurnStarted.promise]);

		expect(prompts).toEqual(["original request", "original request"]);
		expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
		expect(recalledCompositions).toEqual(["next request"]);
		expect(
			engine.getSnapshot().compactions.map(({ trigger }) => trigger)
		).toEqual(["overflow"]);
		await firstSend;
	} finally {
		allowContinuation.resolve();
		await engine.internalPort.shutdown();
	}
});

test("interrupting overflow target resolution prevents recovery compaction", async () => {
	const targetResolutionStarted = Promise.withResolvers<void>();
	const allowTargetResolution = Promise.withResolvers<void>();
	const nextTurnStarted = Promise.withResolvers<void>();
	let turnStarted = false;
	let runCount = 0;
	const prompts: string[] = [];
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => {
			if (turnStarted) {
				targetResolutionStarted.resolve();
				await allowTargetResolution.promise;
			}
			return overflowRecoverySettings();
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				prompts.push(promptOfTurn(request.messages));
				reportTurnStarted(request);
				if (runCount === 1) {
					turnStarted = true;
					return { error: overflowFailure() };
				}
				nextTurnStarted.resolve();
				await completeRuntimeTurn(request);
				return {};
			},
		},
	});

	try {
		await engine.send(sendInput({ userText: "original request" }));
		await targetResolutionStarted.promise;

		expect(await engine.interruptAll()).toMatchObject({ kind: "turn" });
		await engine.send(sendInput({ userText: "next request" }));
		allowTargetResolution.resolve();
		await nextTurnStarted.promise;

		expect(prompts).toEqual(["original request", "next request"]);
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(runCount).toBe(2);
	} finally {
		allowTargetResolution.resolve();
		await engine.internalPort.shutdown();
	}
});

test("interrupting overflow recovery compaction prevents context continuation", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const summaryStarted = Promise.withResolvers<void>();
	const compactionStopped = Promise.withResolvers<void>();
	let recoveryCompactionStarted = false;
	let runCount = 0;
	const delayedSummary: SummaryGenerator = async (input) => {
		summaryStarted.resolve();
		return summaryGenerator(input);
	};
	const engine = createOverflowTestSession(
		compactionHistory(),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async (request) => {
					runCount += 1;
					reportTurnStarted(request);
					return { error: overflowFailure() };
				},
			},
		},
		delayedSummary
	);
	const unsubscribe = engine.subscribe(() => {
		if (engine.getSnapshot().isCompacting) {
			recoveryCompactionStarted = true;
		} else if (recoveryCompactionStarted) {
			compactionStopped.resolve();
		}
	});

	try {
		await engine.send(sendInput({ userText: "overflowing request" }));
		await summaryStarted.promise;
		expect(await engine.interruptAll()).toMatchObject({ kind: "compaction" });
		release();
		await compactionStopped.promise;

		expect(runCount).toBe(1);
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(engine.getSnapshot().compactionError).toBeNull();
	} finally {
		unsubscribe();
		release();
		await engine.internalPort.shutdown();
	}
});

test("shutdown prevents overflow recovery from continuing after compaction", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const summaryStarted = Promise.withResolvers<void>();
	let runCount = 0;
	const delayedSummary: SummaryGenerator = async (input) => {
		summaryStarted.resolve();
		return summaryGenerator(input);
	};
	const engine = createOverflowTestSession(
		compactionHistory(),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async (request) => {
					runCount += 1;
					reportTurnStarted(request);
					return { error: overflowFailure() };
				},
			},
		},
		delayedSummary
	);

	try {
		await engine.send(sendInput({ userText: "overflowing request" }));
		await summaryStarted.promise;
		const shutdown = engine.internalPort.shutdown();
		release();
		await shutdown;

		expect(runCount).toBe(1);
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(engine.getSnapshot().compactionError).toBeNull();
	} finally {
		release();
		await engine.internalPort.shutdown();
	}
});

test("refuses overflow continuation while a public compaction is active", async () => {
	await withLoggerHome(async (home) => {
		const recoverySummaryStarted = Promise.withResolvers<void>();
		const allowRecoverySummary = Promise.withResolvers<void>();
		const manualSummaryStarted = Promise.withResolvers<void>();
		const allowManualSummary = Promise.withResolvers<void>();
		const continuationRefused = Promise.withResolvers<Error>();
		let summaryCount = 0;
		let manualCompactionStarted = false;
		let manualCompaction: Promise<unknown> | undefined;
		const summaryGenerator: SummaryGenerator = async () => {
			summaryCount += 1;
			if (summaryCount === 1) {
				recoverySummaryStarted.resolve();
				await allowRecoverySummary.promise;
				return { text: "overflow summary" };
			}
			if (summaryCount === 2) {
				manualSummaryStarted.resolve();
				await allowManualSummary.promise;
				return { text: "manual summary" };
			}
			throw new Error("Unexpected extra compaction.");
		};
		const engine = createOverflowTestSession(
			compactionHistory(),
			{},
			summaryGenerator
		);
		const unsubscribe = engine.subscribe(() => {
			const snapshot = engine.getSnapshot();
			if (
				!snapshot.isCompacting &&
				snapshot.compactions.some(({ trigger }) => trigger === "overflow") &&
				!manualCompactionStarted
			) {
				manualCompactionStarted = true;
				manualCompaction = engine.compact({ model, trigger: "manual" });
			}
			const error = snapshot.compactionError;
			if (
				error?.message.includes(
					"could not continue the compacted Session Context"
				)
			) {
				continuationRefused.resolve(error);
			}
		});

		try {
			await engine.send(sendInput({ userText: "overflowing request" }));
			await recoverySummaryStarted.promise;
			allowRecoverySummary.resolve();
			await manualSummaryStarted.promise;
			const error = await continuationRefused.promise;

			expect(error).toMatchObject({ code: "continuation-refused" });
			expect(engine.getSnapshot().isCompacting).toBe(true);
			expect(
				engine.getSnapshot().compactions.map(({ trigger }) => trigger)
			).toEqual(["overflow"]);

			allowManualSummary.resolve();
			if (manualCompaction === undefined) {
				throw new Error("The competing compaction did not start.");
			}
			await manualCompaction;
			expect(summaryCount).toBe(2);

			await logger.flush();
			const records = await readLoggerRecords(home).catch(() => []);
			const refusalRecords = records.filter(
				({ message }) => message === "Context overflow recovery failed"
			);
			expect(refusalRecords).toHaveLength(1);
			expect(refusalRecords[0]).toMatchObject({
				context: {
					errorCode: "continuation-refused",
					errorType: "OverflowRecoveryError",
					operation: "session.compaction.overflow",
					phase: "continuation",
					turnId: expect.any(String),
				},
				level: "warn",
			});
			expect(JSON.stringify(refusalRecords[0])).not.toContain(error.message);
		} finally {
			unsubscribe();
			allowRecoverySummary.resolve();
			allowManualSummary.resolve();
			await manualCompaction?.catch(() => undefined);
			await engine.internalPort.shutdown();
		}
	});
});
test("logs failed overflow compaction without continuation or payloads", async () => {
	await withLoggerHome(async (home) => {
		const compactionError = Promise.withResolvers<Error>();
		let runCount = 0;
		const engine = createOverflowTestSession(
			compactionHistory(),
			{
				turnRunner: {
					requestOverheadTokens: () => 0,
					run: async (request) => {
						runCount += 1;
						reportTurnStarted(request);
						return { error: overflowFailure() };
					},
				},
			},
			async () => {
				throw new Error("private summary generation failure");
			}
		);
		const unsubscribe = engine.subscribe(() => {
			const error = engine.getSnapshot().compactionError;
			if (error !== null) {
				compactionError.resolve(error);
			}
		});

		try {
			await engine.send(sendInput({ userText: "private overflow request" }));
			const failure = await compactionError.promise;

			expect(failure.message).toContain("could not compact the session");
			expect(engine.getSnapshot().compactions).toEqual([]);
			expect(runCount).toBe(1);

			await logger.flush();
			const records = await readLoggerRecords(home);
			const compactionRecords = records.filter(
				({ context }) =>
					context?.operation === "session.compaction" &&
					context?.trigger === "overflow"
			);
			expect(compactionRecords).toHaveLength(1);
			expect(compactionRecords[0]).toMatchObject({
				context: {
					errorCode: "summary-failed",
					errorType: "SessionCompactionError",
					phase: "failed",
					turnId: expect.any(String),
				},
				level: "warn",
			});
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"private summary generation failure"
			);
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"private overflow request"
			);
		} finally {
			unsubscribe();
			await engine.internalPort.shutdown();
		}
	});
});

test("retains a queued submission's attachments until its turn runs", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const retained: string[][] = [];
	const released: string[][] = [];
	const holdEnded = Promise.withResolvers<void>();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) =>
					messages.map((sessionMessage) => ({
						...sessionMessage,
						parts: sessionMessage.parts.map((part) =>
							part.type === "file"
								? fromPartial<SessionFilePart>({
										attachmentId: attachmentId("stored-blob"),
										mediaType: part.mediaType,
										type: "file",
										url: "attachment://stored-blob",
									})
								: part
						),
					})),
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => {
					released.push([...attachmentIds]);
					holdEnded.resolve();
				},
				retain: (attachmentIds) => retained.push([...attachmentIds]),
			},
			turnRunner: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];

	// An active compaction keeps this queued Submission on the queue until it
	// settles; the attachment hold prevents its blob from being reclaimed.
	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(
		sendInput({
			composition: compositionOf("[Image 1]", files),
			files,
			userText: "[Image 1]",
		})
	);

	// The queued composition stores its attachments and keeps their blobs, so a
	// long wait cannot reclaim them.
	expect(retained).toEqual([["stored-blob"]]);
	expect(
		engine.getSnapshot().queuedSubmissions[0]?.input.composition.files
	).toEqual([expect.objectContaining({ attachmentId: "stored-blob" })]);

	release();
	await compaction;
	await runtime.started(1);
	expect(released).toEqual([]);
	runtime.release();

	// Running the turn puts the blobs in Session Records, so the hold ends then.
	await holdEnded.promise;
	expect(released).toEqual([["stored-blob"]]);
});
test("releases queued attachment holds when queued preparation rejects", async () => {
	const activeTurnStarted = Promise.withResolvers<void>();
	const allowActiveTurnEnd = Promise.withResolvers<void>();
	const preparationRejected = Promise.withResolvers<void>();
	const retained: string[][] = [];
	const released: string[][] = [];
	let runCount = 0;
	let settingsCount = 0;
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];
	const engine = createTestAgentSession([], undefined, {
		attachments: {
			externalize: async (messages) =>
				messages.map((sessionMessage) => ({
					...sessionMessage,
					parts: sessionMessage.parts.map((part) =>
						part.type === "file"
							? fromPartial<SessionFilePart>({
									attachmentId: attachmentId("failed-queued-blob"),
									mediaType: part.mediaType,
									type: "file",
									url: "attachment://failed-queued-blob",
								})
							: part
					),
				})),
			hydrate: async ({ messages }) => [...messages],
			release: (attachmentIds) => released.push([...attachmentIds]),
			retain: (attachmentIds) => retained.push([...attachmentIds]),
		},
		resolveCompactionSettings: async () => {
			settingsCount += 1;
			if (settingsCount === 2) {
				preparationRejected.resolve();
				throw new Error("The queued Submission could not be prepared.");
			}
			return fromPartial<ResolvedCompactionSettings>({
				autoAvailable: false,
				enabled: true,
				keepRecentTokens: 1,
				maxMediaAttachments: 4,
				maxMediaBytes: 1024,
				maxMediaTokens: 128,
				modelContextLimit: 10_000,
				overflowRecoveryAvailable: false,
				reserveTokens: 1000,
				thresholdTokens: null,
			});
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async () => {
				runCount += 1;
				if (runCount === 1) {
					activeTurnStarted.resolve();
					await allowActiveTurnEnd.promise;
					return {};
				}
				throw new Error(
					"The queued model must not start after preparation fails."
				);
			},
		},
	});
	const active = engine.send(sendInput({ userText: "active turn" }));

	try {
		await activeTurnStarted.promise;
		const queued = await engine.send(
			sendInput({
				composition: compositionOf("[Image 1]", files),
				files,
				userText: "[Image 1]",
			})
		);
		expect(queued).toMatchObject({ rejected: false });
		expect(retained).toEqual([["failed-queued-blob"]]);
		expect(released).toEqual([]);

		allowActiveTurnEnd.resolve();
		await preparationRejected.promise;
		await active;
		await engine.internalPort.shutdown();
		expect(runCount).toBe(1);
		expect(released).toEqual([["failed-queued-blob"]]);
	} finally {
		allowActiveTurnEnd.resolve();
		await active;
		await engine.internalPort.shutdown();
	}
});

test("waits for queued attachment externalization before shutdown settles", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => {
					externalizeStarted.resolve();
					await allowExternalize.promise;
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
			turnRunner: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];

	const compaction = engine.compact({ model, trigger: "manual" });
	const queued = engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);
	await externalizeStarted.promise;
	const cancellation = engine.cancelCompaction();
	const shutdown = engine.internalPort.shutdown();
	release();
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	await cancellation;

	const probe = Promise.withResolvers<"probe">();
	const shutdownSettled = shutdown.then(() => "shutdown" as const);
	const result = Promise.race([shutdownSettled, probe.promise]);
	queueMicrotask(() => probe.resolve("probe"));
	expect(await result).toBe("probe");

	allowExternalize.resolve();
	await expect(queued).resolves.toMatchObject({
		rejected: true,
		reason: "The session has ended.",
	});
	await shutdown;
});

test("steers a Submission with files without losing its attachment", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commits: SessionRecord[] = [];
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: runtime.runtime,
	});
	const fileId = attachmentId(`v1-${"a".repeat(64)}`);
	const messageId = sessionMessageId("steered-file-message");
	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: fileId,
			byteLength: 256,
			filename: "diagram.png",
			mediaType: "image/png",
			type: "file",
			url: `attachment://${fileId}`,
		}),
	];

	const active = engine.send(sendInput({ userText: "active" }));
	await runtime.started(1);
	const accepted = await engine.send(
		sendInput({
			composition: compositionOf("[Image 1]", files),
			files,
			messageId,
			userText: "[Image 1]",
		})
	);
	expect(accepted).toEqual({ rejected: false });

	const steered = await engine.steer();
	expect(steered).toMatchObject({ kind: "steered", messageId });
	const record = commits.find((candidate) =>
		candidate.messages.some(({ id }) => id === messageId)
	);
	expect(record?.messages[0]?.parts).toContainEqual(
		expect.objectContaining({
			attachmentId: fileId,
			type: "attachment-reference",
		})
	);
	expect(
		engine.getSnapshot().transcript.find(({ id }) => id === messageId)?.parts
	).toContainEqual(expect.objectContaining({ attachmentId: fileId }));

	runtime.release();
	await active;
	expect(runtime.boundaries[0]?.delivered).toEqual(["[Image 1]"]);
});

test("drops the queue and its attachment holds when the session shuts down", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const released: string[][] = [];
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => released.push([...attachmentIds]),
				retain: () => undefined,
			},
			turnRunner: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("dropped-blob"),
			type: "file",
			url: "attachment://dropped-blob",
		}),
	];

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);

	const shutdown = engine.internalPort.shutdown();

	expect(released).toEqual([["dropped-blob"]]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	release();
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	await shutdown;
});

test("refuses a submission once the session has shut down", async () => {
	const engine = createTestAgentSession([]);
	await engine.internalPort.shutdown();

	await expect(engine.send(sendInput())).resolves.toEqual({
		rejected: true,
		reason: "The session has ended.",
	});
});
test("ignores runtime callbacks that arrive after shutdown", async () => {
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
	const send = engine.send(sendInput());
	await runtime.started(1);

	const shutdown = engine.internalPort.shutdown();
	const snapshotAtShutdown = engine.getSnapshot();
	runtime.release();
	await shutdown;
	await send;

	expect(engine.getSnapshot().context).toEqual(snapshotAtShutdown.context);
	expect(engine.getSnapshot().transcript).toEqual(
		snapshotAtShutdown.transcript
	);
	expect(engine.getSnapshot().viewState).toEqual(snapshotAtShutdown.viewState);
});

test("releases a recalled submission's attachment hold", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const released: string[][] = [];
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => released.push([...attachmentIds]),
				retain: () => undefined,
			},
			turnRunner: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("held-blob"),
			type: "file",
			url: "attachment://held-blob",
		}),
	];

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);

	await engine.recallWaitingMessages();

	expect(released).toEqual([["held-blob"]]);
	release();
	await compaction;
});

/** A turn that streams one answer through the callbacks it is handed. */
const answeringRuntime = (): AgentSessionPorts["turnRunner"] => ({
	requestOverheadTokens: () => 0,
	run: async ({ callbacks, execution }) => {
		callbacks.onEvent({
			agentId: execution.agent,
			sequence: 0,
			startedAt: 1,
			turnId: execution.turnId,
			type: "agent-turn-started",
		});
		callbacks.onEvent({
			delta: "hello back",
			sequence: 1,
			turnId: execution.turnId,
			type: "text-delta",
		});
		await callbacks.commitTerminal(
			fromPartial<SessionRecord>({
				messages: [
					{
						id: sessionMessageId(`assistant-${execution.turnId}`),
						parts: [{ text: "hello back", type: "text" }],
						role: "assistant",
					},
				],
				outcome: {
					kind: "assistant",
					terminal: { finishedAt: 2, kind: "completed" },
				},
				turnId: execution.turnId,
			})
		);
		callbacks.onTerminal({
			finishedAt: 2,
			sequence: 2,
			turnId: execution.turnId,
			type: "agent-turn-completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		return {};
	},
});

/** A turn that streams one delta and then waits to be let go. */
const createStreamingRuntime = (): {
	/** Resolves once the turn has streamed and is waiting to be let go. */
	readonly live: Promise<void>;
	readonly release: () => void;
	readonly runtime: AgentSessionPorts["turnRunner"];
} => {
	const parked = Promise.withResolvers<void>();
	const live = Promise.withResolvers<void>();
	return {
		live: live.promise,
		release: parked.resolve,
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution }) => {
				callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				callbacks.onEvent({
					delta: "partial",
					sequence: 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				live.resolve();
				await parked.promise;
				return { error: new Error("The Agent Turn was interrupted.") };
			},
		},
	};
};

test("commits the accepted prompt and streams its Agent Turn", async () => {
	const commits: SessionRecord[] = [];
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: answeringRuntime(),
	});

	const outcome = await engine.send(sendInput());

	expect(outcome).toEqual({ rejected: false });
	const prompt = engine
		.getSnapshot()
		.context.find(({ role }) => role === "user");
	expect(prompt?.parts[0]).toMatchObject({ text: "hello", type: "text" });
	const assistant = engine.getSnapshot().context.at(-1);
	expect(assistant?.role).toBe("assistant");
	expect(assistant?.parts[0]).toMatchObject({ text: "hello back" });
	// The prompt is durable before the turn runs, and the terminal row follows it.
	expect(commits).toHaveLength(2);
	expect(commits[0]?.outcome).toEqual({ kind: "user" });
	expect(commits[1]?.outcome).toMatchObject({
		kind: "assistant",
		terminal: { kind: "completed" },
	});
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual(
		engine.getSnapshot().context.map(({ id }) => id)
	);
	expect(engine.getSnapshot().turnActive).toBe(false);
});

test("ignores late provider callbacks after local interruption", async () => {
	const live = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution }) => {
				callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				callbacks.onEvent({
					delta: "before interruption",
					sequence: 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				live.resolve();
				await release.promise;
				callbacks.onEvent({
					delta: "late provider text",
					sequence: 2,
					turnId: execution.turnId,
					type: "text-delta",
				});
				callbacks.onTerminal({
					finishedAt: 2,
					sequence: 3,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
	});

	const send = engine.send(sendInput());
	await live.promise;
	await engine.interrupt();
	release.resolve();
	await send;

	const assistant = engine
		.getSnapshot()
		.context.findLast(({ role }) => role === "assistant");
	expect(assistant?.metadata?.interrupted).toBe(true);
	expect(assistant?.parts).toContainEqual({
		text: "before interruption",
		type: "text",
	});
	expect(assistant?.parts).not.toContainEqual({
		text: "late provider text",
		type: "text",
	});
});

test("retries a stored message without appending another user message", async () => {
	const commits: SessionRecord[] = [];
	const stored = message("u1", "retry me");
	const engine = createTestAgentSession([stored], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: answeringRuntime(),
	});

	const outcome = await engine.send(
		sendInput({ messageId: sessionMessageId("u1"), userText: undefined })
	);

	expect(outcome).toEqual({ rejected: false });
	const context = engine.getSnapshot().context;
	expect(context.filter(({ role }) => role === "user")).toHaveLength(1);
	expect(context.at(-1)?.role).toBe("assistant");
	// The retry reuses the stored message, so no second prompt row is committed.
	expect(commits.map(({ outcome: record }) => record)).toEqual([
		{
			kind: "assistant",
			terminal: expect.objectContaining({ kind: "completed" }),
		},
	]);
});

test("retries a failed Steering Submission in place without duplicating its message", async () => {
	const retryMessageId = sessionMessageId("retry-steering-attachment");
	const fileId = attachmentId(`v1-${"b".repeat(64)}`);
	const acceptedFile = fromPartial<SessionFilePart>({
		attachmentId: fileId,
		byteLength: 256,
		filename: "retry.png",
		mediaType: "image/png",
		type: "file",
		url: `attachment://${fileId}`,
	});
	const hydrationModes: boolean[] = [];
	const turnStarted = Promise.withResolvers<void>();
	const allowBoundary = Promise.withResolvers<void>();
	const retryStarted = Promise.withResolvers<void>();
	const allowRetry = Promise.withResolvers<void>();
	const retryPersistenceStarted = Promise.withResolvers<void>();
	const allowRetryPersistence = Promise.withResolvers<void>();
	const commits: SessionRecord[] = [];
	const submissionStatuses: string[] = [];
	let failedStatusPersisted = false;
	const prompts: string[][] = [];
	let turnCount = 0;
	let retry: Promise<unknown> | undefined;
	const engine = createTestAgentSession([], undefined, {
		attachments: {
			externalize: async (messages) => [...messages],
			hydrate: async ({ failOnMissingAttachments, messages }) => {
				if (messages.some(({ id }) => id === retryMessageId)) {
					hydrationModes.push(failOnMissingAttachments === true);
				}
				return [...messages];
			},
			release: () => undefined,
			retain: () => undefined,
		},
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		updateSubmissionStatus: async ({ messageId, status }) => {
			if (messageId !== retryMessageId) {
				return;
			}
			submissionStatuses.push(status);
			if (status === "failed") {
				failedStatusPersisted = true;
			}
			if (status === "processing" && failedStatusPersisted) {
				retryPersistenceStarted.resolve();
				await allowRetryPersistence.promise;
			}
		},
		skills: {
			createTurnSkill: async () =>
				fromPartial<SessionSkillCatalog>({ diagnostic: null }),
			resolveSkill: async () => ({
				ok: true,
				skill: {
					arguments: "focus",
					contentHash: "skill-hash",
					instructions: "Review with focus.",
					name: "review",
					source: "explicit",
				},
			}),
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, messages, takeSteeringMessages }) => {
				prompts.push(userPrompts(messages));
				turnCount += 1;
				if (turnCount === 1) {
					turnStarted.resolve();
					await allowBoundary.promise;
					const delivered = await takeSteeringMessages();
					expect(userPrompts(delivered)).toEqual([
						'<untrusted-skill-context name="review" source="explicit" content-hash="skill-hash">\nReview with focus.\n<arguments>focus</arguments>\n</untrusted-skill-context>',
						"correction",
					]);
					expect(delivered.at(-1)?.parts).toContainEqual(acceptedFile);
					await callbacks.onTerminal(
						fromPartial<AgentTurnTerminalEvent>({
							failure: { message: "The receiving model request failed." },
							sequence: 2,
							turnId: execution.turnId,
							type: "agent-turn-failed",
						})
					);
					return { error: new Error("The receiving model request failed.") };
				}
				retryStarted.resolve();
				await allowRetry.promise;
				await callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						messages: [
							{
								id: sessionMessageId(`assistant-${execution.turnId}`),
								parts: [{ text: "answer", type: "text" }],
								role: "assistant",
							},
						],
						outcome: {
							kind: "assistant",
							terminal: { finishedAt: 2, kind: "completed" },
						},
						turnId: execution.turnId,
					})
				);
				await callbacks.onTerminal(
					fromPartial<AgentTurnTerminalEvent>({
						sequence: 3,
						turnId: execution.turnId,
						type: "agent-turn-completed",
					})
				);
				return {};
			},
		},
	});
	const active = engine.send(sendInput({ userText: "active turn" }));

	try {
		await turnStarted.promise;
		await engine.send(
			sendInput({
				composition: compositionOf("correction", [acceptedFile]),
				files: [acceptedFile],
				messageId: retryMessageId,
				skill: {
					arguments: "focus",
					instructions: "Review with focus.",
					name: "review",
				},
				userText: "correction",
			})
		);
		const steering = await engine.steer();
		if (steering.kind !== "steered") {
			throw new Error("The queued Submission was not committed.");
		}
		allowBoundary.resolve();
		await active;

		const failedSteering = engine.getSnapshot().steeringMessages[0];
		if (failedSteering === undefined) {
			throw new Error("The failed committed message was not retryable.");
		}
		expect(failedSteering).toMatchObject({
			input: { submissionId: steering.submissionId, userText: "correction" },
			message: {
				id: steering.messageId,
				metadata: { submissionStatus: "failed" },
			},
			status: "failed",
		});
		retry = engine.send(failedSteering.input);
		await retryPersistenceStarted.promise;
		const statusCountBeforeDuplicate = submissionStatuses.length;
		const duplicateRetry = await engine.send(failedSteering.input);
		expect(duplicateRetry).toEqual({
			rejected: true,
			reason: "The committed Submission is already being retried.",
		});
		expect(submissionStatuses).toHaveLength(statusCountBeforeDuplicate);
		allowRetryPersistence.resolve();
		await retryStarted.promise;
		expect(hydrationModes).toEqual([true, true]);

		const transcriptMessage = engine
			.getSnapshot()
			.transcript.find(({ id }) => id === steering.messageId);
		expect(transcriptMessage?.metadata?.submissionStatus).toBe("processing");
		expect(
			prompts[1]?.filter((prompt) => prompt === "correction")
		).toHaveLength(1);
		allowRetry.resolve();
		await retry;

		expect(
			engine
				.getSnapshot()
				.transcript.filter(({ id }) => id === steering.messageId)
		).toHaveLength(1);
		expect(
			engine
				.getSnapshot()
				.transcript.find(({ id }) => id === steering.messageId)?.metadata
				?.submissionStatus
		).toBe("processed");
		expect(
			commits
				.filter(({ outcome }) => outcome.kind === "user")
				.flatMap(({ messages }) =>
					messages.filter(({ id }) => id === steering.messageId)
				)
		).toHaveLength(1);
	} finally {
		allowRetryPersistence.resolve();
		allowBoundary.resolve();
		allowRetry.resolve();
		await active;
		await retry?.catch(() => undefined);
		await engine.internalPort.shutdown();
	}
});

test("cancels the submission it is running and returns to ready", async () => {
	const streaming = createStreamingRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: streaming.runtime,
	});

	const send = engine.send(sendInput());
	engine.cancel();

	await expect(send).resolves.toEqual({
		rejected: true,
		reason: "Session send cancelled.",
	});
	const snapshot = engine.getSnapshot();
	expect(snapshot.turnActive).toBe(false);
	expect(snapshot.executions).toEqual([]);
	expect(snapshot.approvals).toEqual([]);
});

test("deadline expiration aborts a preparing Agent Session send", async () => {
	const externalizeStarted = Promise.withResolvers<void>();
	const files: SessionFilePart[] = [
		{
			filename: "deadline.txt",
			mediaType: "text/plain",
			type: "file",
			url: "data:text/plain;base64,QQ==",
		},
	];
	const engine = new AgentSessionImpl({
		deadlineMs: 0,
		initialTranscript: [],
		ports: createPorts({
			compaction: createCompactionModule(async () => ({ text: "summary" })),
			attachments: {
				externalize: async (messages, signal) => {
					externalizeStarted.resolve();
					const released = Promise.withResolvers<void>();
					const onAbort = (): void => released.resolve();
					if (signal.aborted) {
						onAbort();
					} else {
						signal.addEventListener("abort", onAbort, { once: true });
					}
					await released.promise;
					signal.removeEventListener("abort", onAbort);
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
		}),
		sessionId: sessionId("agent-session-deadline-test"),
	});
	const send = engine.send(sendInput({ files, userText: "deadline" }));
	await externalizeStarted.promise;

	await expect(send).resolves.toEqual({
		rejected: true,
		reason: "Session send deadline exceeded.",
	});
	expect(engine.getSnapshot().turnActive).toBe(false);
	await engine.internalPort.shutdown();
});

test("interrupts the Agent Turn without replaying its failed Steering Message", async () => {
	const accepting = Promise.withResolvers<void>();
	const corrected = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const parked = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, takeSteeringMessages }) => {
				await callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				await callbacks.onEvent({
					delta: "Working",
					sequence: 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				accepting.resolve();
				await corrected.promise;
				await takeSteeringMessages();
				delivered.resolve();
				await parked.promise;
				return { error: new Error("The Agent Turn was interrupted.") };
			},
		},
	});

	const send = engine.send(sendInput({ userText: "one" }));
	await accepting.promise;
	await engine.send(sendInput({ userText: "correction" }));
	const steering = await engine.steer();
	if (steering.kind !== "steered") {
		throw new Error("The committed Steering Message was not accepted.");
	}
	corrected.resolve();
	await delivered.promise;
	engine.interrupt();
	parked.resolve();
	await send;

	const context = engine.getSnapshot().context;
	const assistant = context.findLast(({ role }) => role === "assistant");
	const durableSteering = engine
		.getSnapshot()
		.transcript.find(({ id }) => id === steering.messageId);
	expect(assistant?.metadata?.interrupted).toBe(true);
	expect(userPrompts(context)).not.toContain("correction");
	expect(durableSteering).toMatchObject({
		metadata: { submissionStatus: "failed" },
		role: "user",
	});
	expect(durableSteering?.metadata?.interrupted).toBeUndefined();
	expect(durableSteering?.metadata?.responseTimeMs).toBeUndefined();
});

test("interrupting a turn keeps the Assistant message it already streamed", async () => {
	const streaming = createStreamingRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: streaming.runtime,
	});

	const send = engine.send(sendInput());
	await streaming.live;
	engine.interrupt();
	streaming.release();

	await expect(send).resolves.toEqual({ rejected: false });
	const assistant = engine
		.getSnapshot()
		.context.findLast(({ role }) => role === "assistant");
	expect(assistant?.metadata?.interrupted).toBe(true);
	expect(assistant?.parts).toContainEqual({
		text: "partial",
		type: "text",
	});
});

test("persists the interrupted Agent Turn terminal checkpoint", async () => {
	const commits: SessionRecord[] = [];
	const streaming = createStreamingRuntime();
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				const result = await streaming.runtime.run(request);
				await request.callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						outcome: {
							kind: "assistant",
							terminal: { kind: "cancelled" },
						},
					})
				);
				return result;
			},
		},
	});

	const send = engine.send(sendInput());
	await streaming.live;
	engine.interrupt();
	streaming.release();
	await expect(send).resolves.toEqual({ rejected: false });

	expect(commits.map(({ outcome }) => outcome.kind)).toEqual([
		"user",
		"assistant",
	]);
	expect(commits[1]?.outcome).toMatchObject({
		kind: "assistant",
		terminal: { kind: "cancelled" },
	});
});
test("reflects a durable prompt when interruption lands during its commit", async () => {
	const commitStarted = Promise.withResolvers<void>();
	const releaseCommit = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			if (record.outcome.kind === "user") {
				commitStarted.resolve();
				await releaseCommit.promise;
			}
		},
	});

	const send = engine.send(sendInput({ userText: "durable prompt" }));
	await commitStarted.promise;
	engine.interrupt();
	releaseCommit.resolve();

	await expect(send).resolves.toMatchObject({ rejected: true });
	expect(userPrompts(engine.getSnapshot().context)).toEqual(["durable prompt"]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"durable prompt",
	]);
});
