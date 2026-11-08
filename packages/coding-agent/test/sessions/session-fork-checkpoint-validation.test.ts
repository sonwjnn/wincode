import { expect, test } from "bun:test";
import {
	SESSION_RECORD_VERSION,
	type SessionRecord,
} from "@wincode/agent-core";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import {
	assessSessionForkCheckpoint,
	listSessionForkCheckpointAssessments,
} from "@/modules/sessions/session-fork-checkpoint-validation";
import {
	agentId,
	agentTurnId,
	modelStepId,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";

const userRecord = (): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId("checkpoint-user-record"),
	messages: [
		{
			id: sessionMessageId("checkpoint-user-message"),
			parts: [{ text: "Continue from this accepted input.", type: "text" }],
			role: "user",
		},
	],
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
	outcome: { kind: "user" },
	turnId: agentTurnId("checkpoint-user-turn"),
	version: SESSION_RECORD_VERSION,
});

const toolRecord = (
	recordId: string,
	messageId: string,
	callId: string,
	batchCallIds: readonly string[],
	turnId = "checkpoint-tool-turn"
): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId(recordId),
	messages: [
		{
			id: sessionMessageId(messageId),
			parts: [
				{
					input: { path: "README.md" },
					outcome: { kind: "success", output: { unchanged: true } },
					sequence: 8,
					toolBatch: {
						id: modelStepId("checkpoint-tool-step"),
						toolCallIds: batchCallIds.map((value) => toolCallId(value)),
					},
					toolCallId: toolCallId(callId),
					toolName: "read",
					type: "tool-call",
				},
			],
			role: "assistant",
		},
	],
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
	outcome: { kind: "tool" },
	turnId: agentTurnId(turnId),
	version: SESSION_RECORD_VERSION,
});

const completedAssistantRecord = (): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId("checkpoint-terminal-record"),
	messages: [
		{
			id: sessionMessageId("checkpoint-terminal-message"),
			metadata: {
				sourceUserMessageId: sessionMessageId("checkpoint-user-message"),
			},
			parts: [{ text: "The turn completed.", type: "text" }],
			role: "assistant",
		},
	],
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
	outcome: {
		kind: "assistant",
		terminal: { finishedAt: 100, kind: "completed" },
	},
	turnId: agentTurnId("checkpoint-tool-turn"),
	version: SESSION_RECORD_VERSION,
});

test("accepted user and completed single-call records are valid checkpoint boundaries", () => {
	const user = userRecord();
	const tool = toolRecord(
		"checkpoint-single-tool-record",
		"checkpoint-single-tool-message",
		"checkpoint-single-tool-call",
		["checkpoint-single-tool-call"]
	);

	expect(assessSessionForkCheckpoint([user], user.id)).toMatchObject({
		kind: "valid",
		recordId: user.id,
	});
	expect(assessSessionForkCheckpoint([user, tool], tool.id)).toMatchObject({
		kind: "valid",
		recordId: tool.id,
	});
});

test("a checkpoint refuses to cut inside a record containing multiple messages", () => {
	const user = userRecord();
	const firstMessage = user.messages[0];
	if (firstMessage === undefined) {
		throw new Error("The test record has no accepted user message.");
	}
	const multiMessageRecord: SessionRecord = {
		...user,
		messages: [
			firstMessage,
			{
				...firstMessage,
				id: sessionMessageId("checkpoint-user-message-after-cut"),
				parts: [{ text: "This message must not be split away.", type: "text" }],
			},
		],
	};

	expect(
		assessSessionForkCheckpoint([multiMessageRecord], multiMessageRecord.id)
	).toMatchObject({
		kind: "invalid",
		reason: "A Session checkpoint cannot split a multi-message record.",
	});
});

test("a checkpoint cannot split a parallel Tool Call batch before every result is durable", () => {
	const user = userRecord();
	const firstResult = toolRecord(
		"checkpoint-parallel-first-record",
		"checkpoint-parallel-first-message",
		"checkpoint-parallel-first-call",
		["checkpoint-parallel-first-call", "checkpoint-parallel-second-call"]
	);
	const secondResult = toolRecord(
		"checkpoint-parallel-second-record",
		"checkpoint-parallel-second-message",
		"checkpoint-parallel-second-call",
		["checkpoint-parallel-first-call", "checkpoint-parallel-second-call"]
	);

	expect(
		assessSessionForkCheckpoint([user, firstResult], firstResult.id)
	).toMatchObject({
		kind: "invalid",
		reason: "Parallel Tool Call batch is incomplete at this checkpoint.",
	});
	expect(
		assessSessionForkCheckpoint(
			[user, firstResult, secondResult],
			secondResult.id
		)
	).toMatchObject({ kind: "valid", recordId: secondResult.id });
});

test("a terminal checkpoint is refused when its retained prefix contains an incomplete parallel batch", () => {
	const user = userRecord();
	const firstResult = toolRecord(
		"checkpoint-terminal-parallel-record",
		"checkpoint-terminal-parallel-message",
		"checkpoint-terminal-parallel-call",
		["checkpoint-terminal-parallel-call", "checkpoint-terminal-missing-call"]
	);
	const terminal = completedAssistantRecord();

	expect(
		assessSessionForkCheckpoint([user, firstResult, terminal], terminal.id)
	).toMatchObject({
		kind: "invalid",
		reason: "Parallel Tool Call batch is incomplete at this checkpoint.",
	});
});

test("only completed terminal assistant outcomes are eligible, with stable refusal reasons", () => {
	const user = userRecord();
	const interrupted: SessionRecord = {
		...completedAssistantRecord(),
		id: sessionRecordId("checkpoint-interrupted-record"),
		outcome: {
			kind: "assistant",
			terminal: {
				failure: {
					code: "interrupted",
					details: {},
					message: "The turn was interrupted.",
					retry: "immediate",
					source: "runtime",
					version: 1,
				},
				finishedAt: 101,
				kind: "interrupted",
				reason: "user",
			},
		},
	};

	expect(
		assessSessionForkCheckpoint([user, interrupted], interrupted.id)
	).toMatchObject({
		kind: "invalid",
		reason: "Only completed terminal assistant outcomes are valid checkpoints.",
	});
	expect(
		listSessionForkCheckpointAssessments([user, interrupted]).map(
			({ recordId, kind, status }) => ({ recordId, kind, status })
		)
	).toEqual([
		{ recordId: user.id, kind: "user", status: "valid" },
		{ recordId: interrupted.id, kind: "assistant", status: "invalid" },
	]);
});

test("a completed Tool Call without batch provenance is refused rather than assumed safe", () => {
	const user = userRecord();
	const unverified = toolRecord(
		"checkpoint-unverified-tool-record",
		"checkpoint-unverified-tool-message",
		"checkpoint-unverified-tool-call",
		["checkpoint-unverified-tool-call"]
	);
	const toolMessage = unverified.messages[0];
	const toolPart = toolMessage?.parts[0];
	if (toolMessage === undefined || toolPart?.type !== "tool-call") {
		throw new Error("The test record has no completed Tool Call.");
	}
	const { toolBatch: _toolBatch, ...part } = toolPart;
	const withoutBatch: SessionRecord = {
		...unverified,
		messages: [
			{
				...toolMessage,
				parts: [part],
			},
		],
	};

	expect(
		assessSessionForkCheckpoint([user, withoutBatch], withoutBatch.id)
	).toMatchObject({
		kind: "invalid",
		reason:
			"Tool Call batch membership is unavailable, so this checkpoint cannot be validated.",
	});
});

test("checkpoint assessment identifies the exact source message used by UI controls", () => {
	const user = userRecord();
	expect(listSessionForkCheckpointAssessments([user])).toMatchObject([
		{ messageId: user.messages[0]?.id, recordId: user.id, status: "valid" },
	]);
});
