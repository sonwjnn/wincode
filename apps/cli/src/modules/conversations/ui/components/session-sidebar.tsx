import { TextAttributes } from "@opentui/core";
import {
	type CodingAgentUIMessage,
	codingModes,
	findSupportedChatModelSelection,
	formatModelLabel,
	formatTokenCount,
	formatUsdAmount,
} from "@wincode/ai";
import { useMemo } from "react";
import { useModelPricing } from "@/modules/model-pricing";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { summarizeSessionUsage } from "../../usage/session-usage";
import { WorkspacePath } from "./workspace-path";

const CONTEXT_WARNING_PERCENT = 80;

type SessionSidebarProps = {
	messages: CodingAgentUIMessage[];
	sessionTitle: string;
	width: number;
};

function SectionLabel({ text }: { text: string }) {
	return <text attributes={TextAttributes.BOLD}>{text}</text>;
}

export function SessionSidebar({
	messages,
	sessionTitle,
	width,
}: SessionSidebarProps) {
	const { colors } = useTheme();
	const { mode, model } = usePromptConfig();
	const { table } = useModelPricing();
	const usage = useMemo(
		() => summarizeSessionUsage(messages, model, table),
		[messages, model, table]
	);
	const chatModel = findSupportedChatModelSelection(model);
	const modelLabel = chatModel
		? formatModelLabel(chatModel.displayName)
		: model.modelId;
	const percentColor =
		usage?.contextPercent !== null &&
		usage?.contextPercent !== undefined &&
		usage.contextPercent >= CONTEXT_WARNING_PERCENT
			? colors.error
			: colors.textMuted;

	return (
		<box
			backgroundColor={colors.backgroundPanel}
			flexDirection="column"
			flexShrink={0}
			height="100%"
			paddingX={2}
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
						<SectionLabel text="Context" />
						{usage ? (
							<>
								<text fg={colors.textMuted}>
									{`${formatTokenCount(usage.contextTokens)} tokens`}
								</text>
								{usage.contextPercent === null ? null : (
									<text
										fg={percentColor}
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

					<box flexDirection="column">
						<SectionLabel text="Agents" />
						{codingModes.map((codingMode) => {
							const isActive = codingMode.value === mode;
							return (
								<box
									flexDirection="row"
									justifyContent="space-between"
									key={codingMode.value}
									width="100%"
								>
									<text fg={isActive ? colors.mode[mode] : colors.textMuted}>
										{codingMode.displayName}
									</text>
									<text fg={colors.textMuted}>{modelLabel}</text>
								</box>
							);
						})}
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
