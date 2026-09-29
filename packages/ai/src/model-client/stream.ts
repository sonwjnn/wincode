import type { ModelProtocolStrategy } from "./protocols/types";
import type { ModelStreamPart } from "./types";

export const streamProviderResponse = (
	strategy: ModelProtocolStrategy,
	response: Response,
	signal?: AbortSignal
): AsyncIterable<ModelStreamPart> => {
	if (!response.body) {
		throw new Error("Model provider returned an empty response stream.");
	}
	return strategy.stream(response, signal);
};
