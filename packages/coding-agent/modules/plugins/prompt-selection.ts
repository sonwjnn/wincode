import type { ProviderModelSelection, ThinkingLevel } from "@wincode/ai/sdk";

/** Prompt-selection mutations currently attached to the focused Interactive composer. */
export type PluginPromptSelectionTarget = Readonly<{
	setModel: (model: ProviderModelSelection) => Promise<boolean>;
	setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}>;

export type PluginPromptSelectionBridge = PluginPromptSelectionTarget &
	Readonly<{
		bindPromptSelectionTarget: (
			target: PluginPromptSelectionTarget
		) => () => void;
	}>;

/** Routes global Plugin controls to the currently mounted Interactive composer. */
export const createPluginPromptSelectionBridge =
	(): PluginPromptSelectionBridge => {
		let currentBinding:
			| Readonly<{ target: PluginPromptSelectionTarget }>
			| undefined;

		return Object.freeze({
			bindPromptSelectionTarget(target) {
				const binding = Object.freeze({ target });
				currentBinding = binding;
				return () => {
					if (currentBinding === binding) {
						currentBinding = undefined;
					}
				};
			},
			async setModel(model) {
				const target = currentBinding?.target;
				return target === undefined ? false : target.setModel(model);
			},
			setThinkingLevel(level) {
				currentBinding?.target.setThinkingLevel(level);
			},
		});
	};
