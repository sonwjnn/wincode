import { TextAttributes } from "@opentui/core";
import { type AgentDefinition, type AgentId, builtInAgents } from "@wincode/ai";
import type { ConnectionProviderId } from "@wincode/ai/models";
import { useCallback } from "react";
import {
	type AgentDiagnostic,
	formatAgentDiagnostic,
	useAgentRegistry,
} from "@/modules/agents";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type AgentsDialogContentProps = {
	currentAgent?: AgentId;
	connectedProviderIds?: ReadonlySet<ConnectionProviderId>;
	onSelectAgent: (agent: AgentId) => void;
};

type AgentDialogItem = AgentDefinition & {
	readonly isAvailable?: boolean;
	readonly model?: { readonly providerId: ConnectionProviderId };
	readonly unavailableReason?: string;
};

export const getAgentUnavailableReason = (
	agent: AgentDialogItem,
	connectedProviderIds: ReadonlySet<ConnectionProviderId> | undefined
): string | undefined => {
	if (agent.model && connectedProviderIds !== undefined) {
		return connectedProviderIds.has(agent.model.providerId)
			? undefined
			: `Connect ${agent.model.providerId}`;
	}
	return agent.isAvailable === false ? agent.unavailableReason : undefined;
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
	currentAgent,
	connectedProviderIds,
	onSelectAgent,
}: AgentsDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const registry = useAgentRegistry();
	const agents: readonly AgentDialogItem[] =
		registry?.selectableAgents ?? builtInAgents;
	const selectedTextColor = getContrastingTextColor(colors.selection);

	const handleSelect = useCallback(
		(agent: AgentDefinition) => {
			onSelectAgent(agent.id);
			dialog.close();
		},
		[onSelectAgent, dialog]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No matching agents"
			filterFn={(item, query) =>
				`${item.displayName} ${item.description}`
					.toLowerCase()
					.includes(query.toLowerCase())
			}
			footer={
				registry !== null && registry.diagnostics.length > 0 ? (
					<AgentDiagnosticsFooter diagnostics={registry.diagnostics} />
				) : undefined
			}
			getKey={(item) => item.id}
			isItemActive={(item) => item.id === currentAgent}
			isItemSelectable={(item) =>
				getAgentUnavailableReason(item, connectedProviderIds) === undefined
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
							getAgentUnavailableReason(item, connectedProviderIds)
								? TextAttributes.DIM
								: undefined
						}
						fg={isSelected ? selectedTextColor : colors.text}
						selectable={false}
					>
						{getAgentUnavailableReason(item, connectedProviderIds)
							? `${item.displayName} (${getAgentUnavailableReason(item, connectedProviderIds)})`
							: item.displayName}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};
