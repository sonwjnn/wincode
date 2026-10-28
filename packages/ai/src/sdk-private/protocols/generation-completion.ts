import type { ProviderGenerationCompletion } from "../../sdk.ts";

type IncompleteReason = Extract<
	ProviderGenerationCompletion,
	{ kind: "incomplete" }
>["reason"];

const completed: ProviderGenerationCompletion = { kind: "completed" };
const unknown: ProviderGenerationCompletion = { kind: "unknown" };
const incomplete = (
	reason: IncompleteReason
): ProviderGenerationCompletion => ({ kind: "incomplete", reason });

export const openAiResponsesCompletion = (
	status: "completed" | "incomplete",
	reason: string | undefined
): ProviderGenerationCompletion => {
	if (status === "completed") {
		return completed;
	}
	switch (reason) {
		case "max_output_tokens":
			return incomplete("output-limit");
		case "content_filter":
			return incomplete("filtered");
		default:
			return incomplete("other");
	}
};

export const openAiChatCompletion = (
	reason: string | undefined
): ProviderGenerationCompletion => {
	switch (reason) {
		case "stop":
		case "tool_calls":
		case "function_call":
			return completed;
		case "length":
			return incomplete("output-limit");
		case "content_filter":
			return incomplete("filtered");
		default:
			return unknown;
	}
};

export const anthropicGenerationCompletion = (
	reason: string | undefined
): ProviderGenerationCompletion => {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "tool_use":
			return completed;
		case "max_tokens":
			return incomplete("output-limit");
		case "refusal":
			return incomplete("filtered");
		case "pause_turn":
			return incomplete("other");
		default:
			return unknown;
	}
};

export const googleGenerationCompletion = (
	reason: string | undefined
): ProviderGenerationCompletion => {
	switch (reason) {
		case "STOP":
			return completed;
		case "MAX_TOKENS":
			return incomplete("output-limit");
		case "SAFETY":
		case "RECITATION":
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "IMAGE_SAFETY":
			return incomplete("filtered");
		case "MALFORMED_FUNCTION_CALL":
			return incomplete("other");
		default:
			return unknown;
	}
};

export const unknownGenerationCompletion = (): ProviderGenerationCompletion =>
	unknown;
