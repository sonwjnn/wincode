import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	modelCatalog,
} from "@wincode/ai/models";
import type { CommandHandlerMap } from "@/modules/commands/execute-command";
import { CONNECTION_DIALOG_WIDTH } from "@/modules/connections";
import type { PromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import { EffortDialogContent } from "@/modules/prompt-settings/ui/effort-dialog";
import { getModelsForPicker } from "@/modules/prompt-settings/ui/model-picker-options";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";

type SelectionHandlerDependencies = {
	config: PromptConfig;
	connections: Pick<Connections, "listProviders">;
	dialog: Pick<DialogContextValue, "open">;
	getRecentModelSelections: (limit: number) => ChatModelSelection[];
};

export const createSelectionHandlers = ({
	config,
	connections,
	dialog,
	getRecentModelSelections,
}: SelectionHandlerDependencies): Pick<
	CommandHandlerMap,
	"agent.select" | "effort.select" | "model.select"
> => ({
	"model.select": () => {
		dialog.open({
			children: (
				<ModelsDialogContent
					currentModel={config.model}
					models={getModelsForPicker(modelCatalog, config.model)}
					onSelectModel={config.setModel}
					recentSelections={getRecentModelSelections(10)}
				/>
			),
			padding: { bottom: 1, left: 0, right: 0, top: 1 },
			title: "Select Model",
			titleMargin: { left: 4, right: 4 },
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
	"effort.select": () => {
		const supportedModel = findSupportedChatModelSelection(config.model);
		if (!supportedModel) {
			throw new Error("Effort selection is unavailable in this view.");
		}
		dialog.open({
			children: (
				<EffortDialogContent
					currentEffort={config.effort}
					currentModel={supportedModel}
					currentReasoningMode={config.reasoningMode}
					onSelectDefault={() => config.setEffort(undefined)}
					onSelectEffort={config.setEffort}
					onSelectReasoningMode={config.setReasoningMode}
				/>
			),
			padding: { bottom: 1, left: 0, right: 0, top: 1 },
			title: "Select Effort",
			titleMargin: { left: 4, right: 4 },
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
	"agent.select": async () => {
		const providers = await connections.listProviders();
		dialog.open({
			children: (
				<AgentsDialogContent
					connectedProviderIds={
						new Set(
							providers.filter(({ connected }) => connected).map(({ id }) => id)
						)
					}
					currentAgent={config.agent}
					onSelectAgent={config.setAgent}
				/>
			),
			padding: { bottom: 1, left: 0, right: 0, top: 1 },
			title: "Select Agent",
			titleMargin: { left: 4, right: 4 },
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
});
