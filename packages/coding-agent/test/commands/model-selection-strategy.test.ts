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
): ReactElement<{
	currentModel: ProviderModelSelection;
	recentSelections: readonly ProviderModelSelection[];
}> => {
	if (!isValidElement(children)) {
		throw new Error("The model command did not open a React dialog.");
	}
	return children as ReactElement<{
		currentModel: ProviderModelSelection;
		recentSelections: readonly ProviderModelSelection[];
	}>;
};

test("model selection keeps its legacy title and recent Provider Model history", () => {
	let dialogChildren: unknown;
	let dialogTitle: string | undefined;
	const recentSelection = fromPartial<ProviderModelSelection>({
		modelId: "recent-model",
		providerId: "openai",
	});
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async () => [],
	});
	const context = fromPartial<CommandStrategyContext>({
		config: fromPartial<PromptConfig>({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		}),
		dialog: {
			open: ({ children, title }: { children: ReactNode; title: string }) => {
				dialogChildren = children;
				dialogTitle = title;
			},
		},
		getRecentModelSelections: () => [recentSelection],
		onSelectProviderModel: () => undefined,
		providerController,
	});

	createCommandHandlers(context)["model.select"]();

	const element = readElement(dialogChildren);
	expect(dialogTitle).toBe("Select Model");
	expect(element.type).toBe(ProviderModelsDialogContent);
	expect(element.props.currentModel).toEqual(DEFAULT_PROVIDER_MODEL_SELECTION);
	expect(element.props.recentSelections).toEqual([recentSelection]);
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
