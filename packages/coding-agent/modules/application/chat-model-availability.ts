import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	isActiveChatModel,
} from "@wincode/ai/models";

export type ChatModelAvailability =
	| Readonly<{ status: "available" }>
	| Readonly<{ status: "disconnected" }>
	| Readonly<{ status: "retired" }>
	| Readonly<{ status: "unsupported" }>;

/** Resolves whether a catalog model can be used by a connected provider. */
export const resolveChatModelAvailability = async (
	selection: ChatModelSelection,
	connections: Pick<Connections, "listProviders">
): Promise<ChatModelAvailability> => {
	const model = findSupportedChatModelSelection(selection);
	if (model === null) {
		return { status: "unsupported" };
	}
	if (!isActiveChatModel(model)) {
		return { status: "retired" };
	}
	const providers = await connections.listProviders();
	if (
		!providers.some(
			({ connected, id }) => connected && id === selection.providerId
		)
	) {
		return { status: "disconnected" };
	}
	return { status: "available" };
};
