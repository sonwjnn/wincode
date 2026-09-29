import { isObjectLike } from "@wincode/runtime-utils";

export type OpenAiResponsesInputItem = Readonly<Record<string, unknown>>;

export type OpenAiResponsesFunctionCallItem = OpenAiResponsesInputItem &
	Readonly<{
		arguments: string;
		call_id: string;
		name: string;
		type: "function_call";
	}>;

/** Keeps provider items authoritative and appends each missing local call once, by call_id. */
export const reconcileOpenAiResponsesAssistantContinuation = (
	continuation: readonly unknown[],
	toolCalls: readonly OpenAiResponsesFunctionCallItem[]
): readonly unknown[] => {
	const knownCallIds = new Set<string>();
	for (const candidate of continuation) {
		if (!isObjectLike(candidate) || Array.isArray(candidate)) {
			continue;
		}
		if (
			candidate.type === "function_call" &&
			typeof candidate.call_id === "string"
		) {
			knownCallIds.add(candidate.call_id);
		}
	}

	const inputItems: unknown[] = [...continuation];
	for (const toolCall of toolCalls) {
		if (knownCallIds.has(toolCall.call_id)) {
			continue;
		}
		knownCallIds.add(toolCall.call_id);
		inputItems.push(toolCall);
	}
	return inputItems;
};
