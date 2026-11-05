import { expect, test } from "bun:test";
import {
	createOperationalFailure,
	SESSION_RECORD_VERSION,
	type SessionMessageId,
	type SessionRecord,
} from "@wincode/agent-core";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { indexSessionForkCheckpoints } from "@/modules/sessions/ui/session-fork-checkpoints";
import {
	agentId,
	agentTurnId,
	sessionMessageId,
	sessionRecordId,
} from "../support/identifiers";

const assistantRecord = (
	id: string,
	terminal: "completed" | "failed",
	sourceUserMessageId?: SessionMessageId
): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId(id),
	messages: [
		{
			id: sessionMessageId(`assistant-${id}`),
			...(sourceUserMessageId === undefined
				? {}
				: { metadata: { sourceUserMessageId } }),
			parts: [{ text: id, type: "text" }],
			role: "assistant",
		},
	],
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
	outcome: {
		kind: "assistant",
		terminal:
			terminal === "completed"
				? { finishedAt: 1, kind: "completed" }
				: {
						failure: createOperationalFailure({
							code: "unknown",
							retry: "never",
							source: "runtime",
						}),
						finishedAt: 1,
						kind: "failed",
					},
	},
	turnId: agentTurnId(`turn-${id}`),
	version: SESSION_RECORD_VERSION,
});

test("checkpoint controls expose valid boundaries and stable refusal reasons by visible message", () => {
	const sourceUserMessageId = sessionMessageId("source-user");
	const user: SessionRecord = {
		agentId: agentId("build"),
		id: sessionRecordId("source-user-record"),
		messages: [
			{
				id: sourceUserMessageId,
				parts: [{ text: "Accepted input", type: "text" }],
				role: "user",
			},
		],
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		outcome: { kind: "user" },
		turnId: agentTurnId("source-user-turn"),
		version: SESSION_RECORD_VERSION,
	};
	const completed = assistantRecord(
		"completed-terminal",
		"completed",
		sourceUserMessageId
	);
	const failed = assistantRecord(
		"failed-terminal",
		"failed",
		sourceUserMessageId
	);

	const controls = indexSessionForkCheckpoints([user, completed, failed]);
	expect(controls.get(sourceUserMessageId)).toMatchObject({
		kind: "user",
		recordId: user.id,
		status: "valid",
	});
	expect(
		controls.get(completed.messages[0]?.id as SessionMessageId)
	).toMatchObject({
		recordId: completed.id,
		status: "valid",
	});
	expect(
		controls.get(failed.messages[0]?.id as SessionMessageId)
	).toMatchObject({
		reason: "Only completed terminal assistant outcomes are valid checkpoints.",
		recordId: failed.id,
		status: "invalid",
	});
});
