import { omitUndefined } from "@wincode/utils";
import type {
	ProviderChatFinish,
	ProviderGenerationCompletion,
} from "../sdk.ts";

export const providerChatFinish = (part: {
	completion?: ProviderGenerationCompletion;
	continuation?: unknown;
}): ProviderChatFinish => ({
	...omitUndefined({
		completion: part.completion,
		continuation: part.continuation,
	}),
	type: "finish",
});
