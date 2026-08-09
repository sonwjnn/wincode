import { type AgentDefinition, type AgentId, builtInAgents } from "@wincode/ai";
import { useCallback } from "react";
import { useAgentRegistry } from "@/modules/agents";
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
	onSelectAgent: (agent: AgentId) => void;
};

export const AgentsDialogContent = ({
	currentAgent,
	onSelectAgent,
}: AgentsDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const registry = useAgentRegistry();
	const agents: readonly AgentDefinition[] =
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
			getKey={(item) => item.id}
			isItemActive={(item) => item.id === currentAgent}
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
						fg={isSelected ? selectedTextColor : colors.text}
						selectable={false}
					>
						{item.displayName}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};
