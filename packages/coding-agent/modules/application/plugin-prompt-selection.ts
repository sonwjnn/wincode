import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	isActiveChatModel,
	modelSelectionSchema,
	type ThinkingLevel,
} from "@wincode/ai/models";
import type { PluginPromptSelectionTarget } from "@/modules/plugins/prompt-selection";

type PromptSelectionMutations = Readonly<{
	setModel: (model: ChatModelSelection) => void;
	setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}>;

/** Adapts Plugin selection requests to the focused Interactive composer. */
export const createPluginPromptSelectionTarget = (
	connections: Pick<Connections, "listProviders">,
	promptSelection: PromptSelectionMutations
): PluginPromptSelectionTarget =>
	Object.freeze({
		async setModel(model) {
			const parsed = modelSelectionSchema.safeParse(model);
			if (!parsed.success) {
				return false;
			}
			const supportedModel = findSupportedChatModelSelection(parsed.data);
			if (supportedModel === null || !isActiveChatModel(supportedModel)) {
				return false;
			}
			const providers = await connections.listProviders();
			if (
				!providers.some(
					({ connected, id }) => connected && id === parsed.data.providerId
				)
			) {
				return false;
			}
			promptSelection.setModel(parsed.data);
			return true;
		},
		setThinkingLevel: promptSelection.setThinkingLevel,
	});
