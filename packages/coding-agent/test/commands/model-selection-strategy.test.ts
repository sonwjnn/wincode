import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { defaultChatModelSelection } from "@wincode/ai/models";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { PromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import {
	type CommandStrategyContext,
	createCommandHandlers,
} from "@/tui/commands/command-strategies";

const readElement = (
	children: unknown
): ReactElement<{
	currentModel: ProviderModelSelection;
}> => {
	if (!isValidElement(children)) {
		throw new Error("The model command did not open a React dialog.");
	}
	return children as ReactElement<{ currentModel: ProviderModelSelection }>;
};

test("SDK model selection lists Provider Models and retains the stored default identity", () => {
	let dialogChildren: unknown;
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async () => [],
	});
	const context = fromPartial<CommandStrategyContext>({
		config: fromPartial<PromptConfig>({ model: defaultChatModelSelection }),
		dialog: {
			open: ({ children }: { children: ReactNode }) => {
				dialogChildren = children;
			},
		},
		getRecentModelSelections: () => [],
		onSelectProviderModel: () => undefined,
		providerController,
	});

	createCommandHandlers(context)["model.select"]();

	const element = readElement(dialogChildren);
	expect(element.type).toBe(ProviderModelsDialogContent);
	expect(element.props.currentModel).toEqual(defaultChatModelSelection);
});

test("legacy model selection remains available without a Provider SDK host", () => {
	let dialogChildren: unknown;
	const context = fromPartial<CommandStrategyContext>({
		config: fromPartial<PromptConfig>({ model: defaultChatModelSelection }),
		dialog: {
			open: ({ children }: { children: ReactNode }) => {
				dialogChildren = children;
			},
		},
		getRecentModelSelections: () => [],
	});

	createCommandHandlers(context)["model.select"]();

	const element = readElement(dialogChildren);
	expect(element.type).toBe(ModelsDialogContent);
});
