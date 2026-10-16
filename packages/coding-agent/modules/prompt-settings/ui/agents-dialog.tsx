import { TextAttributes } from "@opentui/core";
import type { AgentDefinition, AgentId } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai/sdk";
import { isNull, isUndefined } from "@wincode/utils";
import { useCallback, useState } from "react";
import {
	type AgentDiagnostic,
	builtInAgents,
	formatAgentDiagnostic,
	useAgentRegistry,
} from "@/modules/agents";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	isAvailableProviderModelSelection,
	isSameProviderModelIdentity,
	type ProviderModelSelection,
	providerModelSelectionForProviderModel,
} from "@/modules/providers/provider-model-selection";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type AgentsDialogContentProps = {
	availableProviderModels?: readonly ProviderModel[];
	currentAgent?: AgentId;
	providerController?: InteractiveProviderController;
	onSelectAgent: (agent: AgentId, model?: ProviderModelSelection) => void;
};

type AgentDialogItem = AgentDefinition & {
	readonly isAvailable?: boolean;
	readonly model?: ProviderModelSelection;
	readonly unavailableReason?: string;
};

export const canReplaceUnavailableAgentModel = (
	agent: AgentDialogItem,
	availableProviderModels: readonly ProviderModel[] | undefined
): boolean => {
	const pinnedModel = agent.model;
	return (
		pinnedModel !== undefined &&
		availableProviderModels !== undefined &&
		availableProviderModels.length > 0 &&
		agent.isAvailable !== false &&
		!isAvailableProviderModelSelection(pinnedModel, availableProviderModels)
	);
};

const AgentModelReplacementDialogContent = ({
	agent,
	models,
	onSelect,
	providerController,
}: {
	agent: AgentDialogItem;
	models: readonly ProviderModel[];
	onSelect: (model: ProviderModelSelection) => void;
	providerController?: InteractiveProviderController;
}) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	useDialogEscape();
	return (
		<SearchListDialogWrapper
			emptyText="No available Provider Models for this Agent."
			getKey={(model) => `${model.providerId}:${model.modelId}`}
			getSearchText={(model) => `${model.providerId} ${model.modelId}`}
			isItemSelectable={() => true}
			items={models}
			onSelect={(model) => {
				const registration = providerController?.getPluginProviderComposition?.(
					model.providerId
				)?.registration;
				const selection = providerModelSelectionForProviderModel(
					model,
					registration === undefined
						? undefined
						: {
								pluginId: registration.pluginId,
								sourceIdentity: registration.sourceIdentity,
							}
				);
				onSelect(selection);
				dialog.close();
			}}
			placeholder={`Choose a replacement for ${agent.displayName}`}
			renderItem={(model, isSelected) => (
				<SelectableDialogItem>
					<text fg={isSelected ? colors.primary : colors.text}>
						{`${model.providerId}/${model.modelId}`}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};

export const getAgentUnavailableReason = (
	agent: AgentDialogItem,
	availableProviderModels?: readonly ProviderModel[]
): string | undefined => {
	if (agent.isAvailable === false) {
		return agent.unavailableReason ?? "Agent is unavailable";
	}
	const pinnedModel = agent.model;
	if (pinnedModel !== undefined) {
		if (availableProviderModels === undefined) {
			return "Provider Model availability cannot be checked in this Host";
		}
		const isAvailable = isAvailableProviderModelSelection(
			pinnedModel,
			availableProviderModels
		);
		if (!isAvailable) {
			return `Provider Model ${pinnedModel.providerId}/${pinnedModel.modelId} is unavailable`;
		}
	}
	return;
};

const agentDialogItemLabel = (
	agent: AgentDialogItem,
	availableProviderModels: readonly ProviderModel[] | undefined
): string => {
	if (canReplaceUnavailableAgentModel(agent, availableProviderModels)) {
		return `${agent.displayName} (choose a replacement model)`;
	}
	const unavailableReason = getAgentUnavailableReason(
		agent,
		availableProviderModels
	);
	return unavailableReason === undefined
		? agent.displayName
		: `${agent.displayName} (${unavailableReason})`;
};

export const AgentDiagnosticsFooter = ({
	diagnostics,
}: {
	diagnostics: readonly AgentDiagnostic[];
}) => {
	const { colors } = useTheme();
	return (
		<box flexDirection="column" marginX={2}>
			<text fg={colors.error} selectable={false}>
				Agent configuration diagnostics
			</text>
			<scrollbox height={Math.min(5, diagnostics.length)}>
				{diagnostics.map((diagnostic) => {
					const detail = formatAgentDiagnostic(diagnostic);
					return (
						<text
							fg={colors.textMuted}
							key={detail}
							selectable={false}
							wrapMode="word"
						>
							{detail}
						</text>
					);
				})}
			</scrollbox>
		</box>
	);
};

export const AgentsDialogContent = ({
	availableProviderModels,
	currentAgent,
	providerController,
	onSelectAgent,
}: AgentsDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const registry = useAgentRegistry();
	const [replacementAgent, setReplacementAgent] = useState<AgentDialogItem>();
	const agents: readonly AgentDialogItem[] =
		availableProviderModels === undefined
			? (registry?.selectableAgents ?? builtInAgents)
			: (registry?.agents.filter(({ role }) => role !== "subagent") ??
				builtInAgents);
	const selectedTextColor = getContrastingTextColor(colors.selection);

	const handleSelect = useCallback(
		(agent: AgentDialogItem) => {
			if (canReplaceUnavailableAgentModel(agent, availableProviderModels)) {
				setReplacementAgent(agent);
				return;
			}
			const pinnedModel = agent.model;
			const availableModel =
				pinnedModel === undefined
					? undefined
					: availableProviderModels?.find((model) =>
							isSameProviderModelIdentity(model, pinnedModel)
						);
			const registration =
				availableModel === undefined
					? undefined
					: providerController?.getPluginProviderComposition?.(
							availableModel.providerId
						)?.registration;
			const selectedModel =
				availableModel === undefined
					? pinnedModel
					: providerModelSelectionForProviderModel(
							availableModel,
							registration === undefined
								? undefined
								: {
										pluginId: registration.pluginId,
										sourceIdentity: registration.sourceIdentity,
									}
						);
			onSelectAgent(
				agent.id,
				availableProviderModels === undefined ? undefined : selectedModel
			);
			dialog.close();
		},
		[availableProviderModels, onSelectAgent, providerController, dialog]
	);

	useDialogEscape();

	if (replacementAgent !== undefined && availableProviderModels !== undefined) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.textMuted}>
					{`The pinned model for ${replacementAgent.displayName} is unavailable. Choose an available replacement explicitly.`}
				</text>
				<AgentModelReplacementDialogContent
					agent={replacementAgent}
					models={availableProviderModels}
					onSelect={(replacement) => {
						onSelectAgent(replacementAgent.id, replacement);
						dialog.close();
					}}
					providerController={providerController}
				/>
			</box>
		);
	}

	return (
		<SearchListDialogWrapper
			emptyText="No matching agents"
			footer={
				!isNull(registry) && registry.diagnostics.length > 0 ? (
					<AgentDiagnosticsFooter diagnostics={registry.diagnostics} />
				) : undefined
			}
			footerMargin={{ left: 0, right: 0 }}
			getKey={(item) => item.id}
			getSearchText={(item) => `${item.displayName} ${item.description}`}
			isItemActive={(item) => item.id === currentAgent}
			isItemSelectable={(item) =>
				isUndefined(getAgentUnavailableReason(item, availableProviderModels)) ||
				canReplaceUnavailableAgentModel(item, availableProviderModels)
			}
			items={agents}
			onSelect={handleSelect}
			placeholder="Search agents"
			renderItem={(item, isSelected, isActive) => (
				<SelectableDialogItem
					status={
						isActive ? (
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{"●"}
							</text>
						) : null
					}
				>
					<text
						attributes={
							getAgentUnavailableReason(item, availableProviderModels)
								? TextAttributes.DIM
								: undefined
						}
						fg={isSelected ? selectedTextColor : colors.text}
						selectable={false}
					>
						{agentDialogItemLabel(item, availableProviderModels)}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};
