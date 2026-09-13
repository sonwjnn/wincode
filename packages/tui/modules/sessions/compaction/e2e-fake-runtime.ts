import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
} from "@wincode/agent-core";

export type FakeMessageRequest = {
	readonly id: string;
	readonly role: string;
	readonly text: string;
};

export type FakeGenerationRequest =
	| {
			readonly kind: "chat";
			readonly messages: readonly FakeMessageRequest[];
	  }
	| {
			readonly kind: "summary";
			readonly system: string;
			readonly text: string;
	  };

export type FakeAiSdkRecorder = {
	readonly requests: FakeGenerationRequest[];
	readonly summaryText: string;
};

const messageText = (message: AgentTurn["input"]["messages"][number]): string =>
	message.parts.map((part) => ("text" in part ? part.text : "")).join("\n");

const createFakeRuntime = (recorder: FakeAiSdkRecorder): AgentRuntime => ({
	async *run(turn: AgentTurn): AsyncGenerator<AgentTurnEvent> {
		recorder.requests.push({
			kind: "chat",
			messages: turn.input.messages.map((message) => ({
				id: message.id,
				role: message.role,
				text: messageText(message),
			})),
		});
		yield {
			agentId: turn.agent.id,
			sequence: 0,
			startedAt: 1,
			turnId: turn.id,
			type: "agent-turn-started",
		};
		yield {
			modelId: turn.model.modelId,
			sequence: 1,
			stepId: "e2e-step",
			turnId: turn.id,
			type: "model-step-started",
		};
		yield {
			delta: "E2E chat response",
			sequence: 2,
			turnId: turn.id,
			type: "text-delta",
		};
		yield {
			modelId: turn.model.modelId,
			sequence: 3,
			stepId: "e2e-step",
			turnId: turn.id,
			type: "model-step-finished",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
		yield {
			finishedAt: 2,
			sequence: 4,
			turnId: turn.id,
			type: "agent-turn-completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
	},
});

export const createFakeAiSdkModule = (recorder: FakeAiSdkRecorder) => ({
	createAiSdkAgentRuntime: () => createFakeRuntime(recorder),
	generateAiSdkText: async (options: {
		readonly messages?: readonly {
			content: string;
			role: "assistant" | "user";
		}[];
		readonly prompt?: string;
		readonly system: string;
	}) => {
		const text =
			options.messages?.map((message) => message.content).join("\n") ??
			options.prompt ??
			"";
		recorder.requests.push({
			kind: "summary",
			system: options.system,
			text,
		});
		return {
			text: recorder.summaryText,
			usage: { inputTokens: 10, outputTokens: 2 },
		};
	},
});

export const createFakeAiSdkRecorder = (): FakeAiSdkRecorder => ({
	requests: [],
	summaryText: "E2E compacted summary",
});
