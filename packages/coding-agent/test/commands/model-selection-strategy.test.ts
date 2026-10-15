import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { PromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	DEFAULT_PROVIDER_MODEL_SELECTION,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import {
	type CommandStrategyContext,
	createCommandHandlers,
} from "@/tui/commands/command-strategies";

const readElement = (
	children: unknown
): ReactElement<{ currentModel: ProviderModelSelection }> => {
	if (!isValidElement(children)) {
		throw new Error("The model command did not open a React dialog.");
	}
	return children as ReactElement<{ currentModel: ProviderModelSelection }>;
};

test("model selection opens the Provider Models dialog with the stored identity", () => {
	let dialogChildren: unknown;
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async () => [],
	});
	const context = fromPartial<CommandStrategyContext>({
		config: fromPartial<PromptConfig>({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		}),
		dialog: {
			open: ({ children }: { children: ReactNode }) => {
				dialogChildren = children;
			},
		},
		onSelectProviderModel: () => undefined,
		providerController,
	});

	createCommandHandlers(context)["model.select"]();

	const element = readElement(dialogChildren);
	expect(element.type).toBe(ProviderModelsDialogContent);
	expect(element.props.currentModel).toEqual(DEFAULT_PROVIDER_MODEL_SELECTION);
});

test("model selection fails closed when its Provider controller is unavailable", () => {
	const context = fromPartial<CommandStrategyContext>({
		config: fromPartial<PromptConfig>({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		}),
		dialog: { open: () => undefined },
		onSelectProviderModel: () => undefined,
	});

	expect(() => createCommandHandlers(context)["model.select"]()).toThrow(
		"Provider Model selection is unavailable in this view."
	);
});
