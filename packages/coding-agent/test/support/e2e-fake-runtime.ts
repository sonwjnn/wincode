import type {
	ModelClient,
	ModelPromptMessage,
	ModelStepRequest,
	ModelStreamPart,
	ModelTextGenerationMessage,
	ModelTextGenerationOptions,
	ModelTextGenerationResult,
} from "@wincode/ai/model-client";

export type FakeMessageRequest = {
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

export type FakeModelClientRecorder = {
	readonly requests: FakeGenerationRequest[];
	readonly summaryText: string;
};

export type FakeModelStepScript = (
	request: ModelStepRequest,
	recorder: FakeModelClientRecorder
) => AsyncGenerator<ModelStreamPart>;

const promptMessageText = (message: ModelPromptMessage): string =>
	message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");

const defaultModelStepScript: FakeModelStepScript = async function* (
	request,
	recorder
): AsyncGenerator<ModelStreamPart> {
	recorder.requests.push({
		kind: "chat",
		messages: request.messages.map((message) => ({
			role: message.role,
			text: promptMessageText(message),
		})),
	});
	yield { delta: "E2E chat response", type: "text-delta" };
	yield {
		type: "finish",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
};

export const createFakeModelClient = (
	recorder: FakeModelClientRecorder,
	run: FakeModelStepScript = defaultModelStepScript
): ModelClient => ({ stream: (request) => run(request, recorder) });

export const createFakeModelClientModule = (
	recorder: FakeModelClientRecorder,
	run: FakeModelStepScript = defaultModelStepScript
) => ({
	createModelClient: () => createFakeModelClient(recorder, run),
	generateModelText: async (
		options: ModelTextGenerationOptions
	): Promise<ModelTextGenerationResult> => {
		const text =
			options.messages
				?.map((message: ModelTextGenerationMessage) => message.content)
				.join("\n") ??
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

export const createFakeModelClientRecorder = (): FakeModelClientRecorder => ({
	requests: [],
	summaryText: "E2E compacted summary",
});
