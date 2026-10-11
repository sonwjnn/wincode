import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	modelSelectionSchema,
	type ThinkingLevel,
} from "@wincode/ai/models";
import type { PluginPromptSelectionTarget } from "@/modules/plugins/prompt-selection";
import { resolveChatModelAvailability } from "./chat-model-availability";

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
			const availability = await resolveChatModelAvailability(
				parsed.data,
				connections
			);
			if (availability.status !== "available") {
				return false;
			}
			promptSelection.setModel(parsed.data);
			return true;
		},
		setThinkingLevel: promptSelection.setThinkingLevel,
	});
