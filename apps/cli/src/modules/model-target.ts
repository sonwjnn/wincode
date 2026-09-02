import {
	createModelTarget,
	type ModelTarget,
	type ModelTargetOptions,
} from "@wincode/ai/model";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { Connections } from "./connections";

export type ResolveChatModelTargetOptions = ModelTargetOptions & {
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
