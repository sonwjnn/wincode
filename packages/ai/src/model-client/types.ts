import type { JsonObject, RequireOneOrNone } from "type-fest";
import type { ModelTarget } from "../model-target";
import type { ModelUsage } from "../model-usage";

export type ModelPromptPart =
	| Readonly<{ text: string; type: "text" }>
	| Readonly<{ data: string | Uint8Array; mediaType: string; type: "file" }>
	| Readonly<{
			input: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-call";
	  }>
	| Readonly<{
			output: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-result";
	  }>
	| Readonly<{
			errorText: string;
			failure?: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-failure";
	  }>;

export type ModelPromptMessage = Readonly<{
	/** Opaque provider continuation retained only for a later request in this turn. */
	continuation?: unknown;
	content: readonly ModelPromptPart[];
	role: "assistant" | "tool" | "user";
}>;

export type ModelTool = Readonly<{
	description: string;
	inputSchema: JsonObject;
	name: string;
}>;

export type ModelStepRequest = Readonly<{
	messages: readonly ModelPromptMessage[];
	signal?: AbortSignal;
	system?: string;
	target: ModelTarget;
	tools?: readonly ModelTool[];
}>;

export type ModelStreamPart =
	| Readonly<{ delta: string; type: "text-delta" | "reasoning-delta" }>
	| Readonly<{
			input: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-call";
	  }>
	| Readonly<{
			continuation?: unknown;
			type: "finish";
			usage?: ModelUsage;
	  }>;

export type ModelClientOptions = Readonly<{
	fetch?: typeof fetch;
}>;

export type ModelClient = Readonly<{
	stream: (request: ModelStepRequest) => AsyncIterable<ModelStreamPart>;
}>;

export type ModelTextGenerationMessage = Readonly<{
	content: string;
	role: "assistant" | "user";
}>;

export type ModelTextGenerationSource = RequireOneOrNone<
	{
		readonly messages: readonly ModelTextGenerationMessage[];
		readonly prompt: string;
	},
	"messages" | "prompt"
>;

export type ModelTextGenerationOptions = Readonly<{
	maxOutputTokens: number;
	model: ModelTarget;
	signal?: AbortSignal;
	system: string;
}> &
	ModelTextGenerationSource;

export type ModelTextGenerationResult = Readonly<{
	text: string;
	usage?: ModelUsage;
}>;
