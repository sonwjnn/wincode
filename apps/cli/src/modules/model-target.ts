import {
	createModelTarget,
	type ModelProviderResolutionOptions,
	type ModelTarget,
} from "@wincode/ai/model";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { Connections } from "./connections";

export type ResolveChatModelTargetOptions = ModelProviderResolutionOptions & {
	readonly signal?: AbortSignal;
};

export async function resolveChatModelTarget(
	selection: ChatModelSelection,
	connections: Connections,
	options: ResolveChatModelTargetOptions = {}
): Promise<ModelTarget> {
	const { signal, ...targetOptions } = options;
	const authorization = await connections.authorize(
		selection.providerId,
		signal
	);
	return createModelTarget(selection, authorization, targetOptions);
}
