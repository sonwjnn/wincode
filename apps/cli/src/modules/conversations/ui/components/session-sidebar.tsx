import { TextAttributes } from "@opentui/core";
import {
	builtInAgents,
	type CodingAgentUIMessage,
	findSupportedChatModelSelection,
	formatModelLabel,
	formatTokenCount,
	formatUsdAmount,
} from "@wincode/ai";
import { useMemo } from "react";
import {
	type McpServerState,
	type McpServerStatus,
	useMcp,
} from "@/modules/mcp";
import { useModelPricing } from "@/modules/model-pricing";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { summarizeSessionUsage } from "../../usage/session-usage";
import { WorkspacePath } from "./workspace-path";

const CONTEXT_WARNING_PERCENT = 80;

const formatMcpSidebarState = (state: McpServerState): string =>
	`${state.charAt(0).toUpperCase()}${state.slice(1)}`;

type SessionSidebarProps = {
	messages: CodingAgentUIMessage[];
	sessionTitle: string;
	width: `${number}%`;
};

function SectionLabel({ text, color }: { text: string; color: string }) {
	return (
		<text attributes={TextAttributes.BOLD} fg={color}>
			{text}
		</text>
	);
}

export function McpSidebarSection({
	statuses,
}: {
	statuses: readonly McpServerStatus[];
}) {
	const { colors } = useTheme();
	return (
		<box flexDirection="column">
			<SectionLabel color={colors.text} text="MCP" />
			{statuses.length === 0 ? (
				<text fg={colors.textMuted}>No MCPs</text>
			) : (
				statuses.map((status) => {
					const isConnected = status.state === "connected";
					return (
						<box flexDirection="row" gap={1} key={status.name} width="100%">
							<text fg={isConnected ? colors.success : colors.textDisabled}>
								•
							</text>
							<box flexGrow={1} overflow="hidden">
								<text fg={colors.text} wrapMode="none">
									{status.name}
								</text>
							</box>
							<text fg={colors.textMuted} flexShrink={0} wrapMode="none">
								{formatMcpSidebarState(status.state)}
							</text>
						</box>
					);
				})
			)}
		</box>
	);
}

export function SessionSidebar({
	messages,
	sessionTitle,
	width,
}: SessionSidebarProps) {
	const { colors } = useTheme();
	const { statuses } = useMcp();
	const { model } = usePromptConfig();
	const { table } = useModelPricing();
	const usage = useMemo(
		() => summarizeSessionUsage(messages, model, table),
		[messages, model, table]
	);
	const chatModel = findSupportedChatModelSelection(model);
	const modelLabel = chatModel
		? formatModelLabel(chatModel.displayName)
		: model.modelId;
	const isContextWarning =
		usage?.contextPercent !== null &&
		usage?.contextPercent !== undefined &&
		usage.contextPercent >= CONTEXT_WARNING_PERCENT;

	return (
		<box
			backgroundColor={colors.backgroundPanel}
			flexDirection="column"
			flexShrink={0}
			height="100%"
			paddingLeft={2}
			paddingRight={3}
			paddingY={1}
			width={width}
		>
			<scrollbox
				flexGrow={1}
				verticalScrollbarOptions={{ visible: false }}
				width="100%"
			>
				<box flexDirection="column" gap={1}>
					<text attributes={TextAttributes.BOLD} fg={colors.text}>
						{sessionTitle}
					</text>

					<box flexDirection="column">
						<SectionLabel color={colors.text} text="Context" />
						{usage ? (
							<>
								<text fg={colors.textMuted}>
									{`${formatTokenCount(usage.contextTokens)} tokens`}
								</text>
								{usage.contextPercent === null ? null : (
									<text
										fg={isContextWarning ? colors.error : colors.textMuted}
									>{`${usage.contextPercent}% used`}</text>
								)}
								{usage.costUsd === null ? null : (
									<text fg={colors.textMuted}>
										{`${formatUsdAmount(usage.costUsd)} spent`}
									</text>
								)}
							</>
						) : (
							<text fg={colors.textMuted}>No usage yet</text>
						)}
					</box>

					<McpSidebarSection statuses={statuses} />

					<box flexDirection="column">
						<SectionLabel color={colors.text} text="Agents" />
						{builtInAgents.map((agent) => (
							<box
								flexDirection="row"
								justifyContent="space-between"
								key={agent.id}
								width="100%"
							>
								<text fg={colors.textMuted}>
									{agent.displayName.toLowerCase()}
								</text>
								<text fg={colors.textMuted}>{modelLabel.toLowerCase()}</text>
							</box>
						))}
					</box>
				</box>
			</scrollbox>

			<box flexDirection="column" flexShrink={0} gap={1}>
				<WorkspacePath />
				<text>
					<span fg={colors.primary}>{"• "}</span>
					<span fg={colors.textMuted}>Win</span>
					<b fg={colors.text}>Code</b>
					<span fg={colors.textMuted}>{` ${APP_VERSION}`}</span>
				</text>
			</box>
		</box>
	);
}
