import { expect, test } from "bun:test";
import { createModelTarget } from "@wincode/ai/model-target";
import { supportedChatModelIdSchema } from "@wincode/ai/models";
import {
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnMessage,
	agentIdSchema,
	createStatefulAgent,
	toAgentTurnId,
	toSessionMessageId,
} from "../src/index";

const message = (
	id: string,
	role: AgentTurnMessage["role"],
	text: string
): AgentTurnMessage => ({
	id: toSessionMessageId(id),
	parts: [{ text, type: "text" }],
	role,
});

const buildTurn = (
	id: string,
	messages: readonly AgentTurnMessage[]
): AgentTurn => ({
	agent: {
		displayName: "Build",
		id: agentIdSchema.parse("build"),
		instructions: "Implement the request.",
		role: "primary",
	},
	id: toAgentTurnId(id),
	input: { messages: [...messages] },
	model: createModelTarget(
		{
			modelId: supportedChatModelIdSchema.parse("gpt-5.6-luna"),
			providerId: "openai",
		},
		{ kind: "api-key", apiKey: "test-key" }
	),
});

const consume = async (
	stream: AsyncIterable<AgentTurnEvent>
): Promise<void> => {
	for await (const _event of stream) {
		// Consume the run so Stateful Agent context commits at its event boundary.
	}
};

test("a failed queued-input commit stays Recall-able and Recall waits for the next commit", async () => {
	const runtime: AgentRuntime = {
		run: () => ({
			async *[Symbol.asyncIterator]() {
				// Queue contract coverage does not invoke the model runtime.
			},
		}),
	};
	const agent = createStatefulAgent<{ id: string; text: string }>({
		getQueuedSubmissionId: ({ id }) => id,
		runtime,
	});
	const first = { id: "first", text: "first submission" };
	const second = { id: "second", text: "second submission" };
	agent.enqueueSubmission(first);
	agent.enqueueSubmission(second);

	const failed = await agent.steerQueuedSubmission(async () => ({
		committed: false,
		receipt: "storage refused the first submission",
	}));
	expect(failed).toMatchObject({ kind: "settled", committed: false });
	expect(agent.getSnapshot().queuedSubmissions).toEqual([first, second]);

	const commitStarted = Promise.withResolvers<void>();
	const releaseCommit = Promise.withResolvers<void>();
	const steered = agent.steerQueuedSubmission(async (submission) => {
		commitStarted.resolve();
		await releaseCommit.promise;
		return { committed: true, receipt: submission.id };
	});
	await commitStarted.promise;
	const recalled = agent.recallQueuedSubmissions();
	expect(agent.getSnapshot().queuedSubmissions).toEqual([first, second]);

	releaseCommit.resolve();
	expect(await steered).toEqual({
		kind: "settled",
		committed: true,
		receipt: "first",
	});
	expect(await recalled).toEqual([second]);
	expect(agent.getSnapshot().queuedSubmissions).toEqual([]);
	await agent.shutdown();
});

test("an empty queue-head Steer cannot claim a Submission admitted afterward", async () => {
	const agent = createStatefulAgent<{ id: string; text: string }>({
		getQueuedSubmissionId: ({ id }) => id,
		runtime: {
			run: () => ({
				async *[Symbol.asyncIterator]() {
					// This contract does not invoke the model runtime.
				},
			}),
		},
	});
	const later = { id: "later", text: "later submission" };
	const steer = agent.steerQueuedSubmission(async () => ({
		committed: true,
		receipt: "committed",
	}));
	agent.enqueueSubmission(later);

	expect(await steer).toEqual({ kind: "empty" });
	expect(agent.getQueuedSubmissions()).toEqual([later]);
	await agent.shutdown();
});

test("idle input selection prioritizes steering before FIFO Submissions", async () => {
	let runtimeStarts = 0;
	const agent = createStatefulAgent<{ id: string; text: string }>({
		getQueuedSubmissionId: ({ id }) => id,
		runtime: {
			run: () => {
				runtimeStarts += 1;
				return {
					async *[Symbol.asyncIterator]() {
						// This selection contract does not execute a turn.
					},
				};
			},
		},
	});
	agent.enqueueSubmission({ id: "first", text: "first submission" });
	agent.enqueueSubmission({ id: "second", text: "second submission" });

	expect(agent.selectNextInput({ hasSteeringMessages: true })).toBe("steering");
	expect(agent.selectNextInput({ hasSteeringMessages: false })).toBe(
		"submission"
	);
	expect(agent.getQueuedSubmissions().map(({ id }) => id)).toEqual([
		"first",
		"second",
	]);
	expect(runtimeStarts).toBe(0);
	await agent.shutdown();
});

test("Stateful Agent owns live model context across turns and rebases compacted history", async () => {
	const runtimeInputs: (readonly AgentTurnMessage[])[] = [];
	const runtime: AgentRuntime = {
		run(turn) {
			runtimeInputs.push(turn.input.messages);
			return {
				async *[Symbol.asyncIterator]() {
					yield {
						delta: `response-${turn.id}`,
						sequence: 0,
						turnId: turn.id,
						type: "text-delta",
					};
					yield {
						finishedAt: 1,
						sequence: 1,
						turnId: turn.id,
						type: "agent-turn-completed",
					};
				},
			};
		},
	};
	const agent = createStatefulAgent({ runtime });
	const firstUser = message("user-1", "user", "first request");
	await consume(agent.run(buildTurn("turn-1", [firstUser])));

	const firstAssistant = message(
		"assistant-turn-1",
		"assistant",
		"response-turn-1"
	);
	const secondUser = message("user-2", "user", "second request");
	await consume(
		agent.run(buildTurn("turn-2", [firstUser, firstAssistant, secondUser]))
	);

	const compactedHistory = message("compacted-context", "user", "summary");
	const thirdUser = message("user-3", "user", "third request");
	await consume(agent.run(buildTurn("turn-3", [compactedHistory, thirdUser])));

	expect(runtimeInputs[0]).toEqual([firstUser]);
	expect(runtimeInputs[1]).toEqual([firstUser, firstAssistant, secondUser]);
	expect(runtimeInputs[2]).toEqual([compactedHistory, thirdUser]);
	expect(agent.getSnapshot().context).toEqual([
		compactedHistory,
		thirdUser,
		message("assistant-turn-3", "assistant", "response-turn-3"),
	]);
	await agent.shutdown();
});
