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
	return <text>{text}</text>;
}

export function SessionSidebar({
	messages,
	sessionTitle,
	width,
}: SessionSidebarProps) {
	const { colors } = useTheme();
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
			backgroundColor={colors.sidebarBackground}
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
					<text>{sessionTitle}</text>

					<box flexDirection="column">
						<SectionLabel text="Context" />
						{usage ? (
							<>
								<text attributes={TextAttributes.DIM}>
									{`${formatTokenCount(usage.contextTokens)} tokens`}
								</text>
								{usage.contextPercent === null ? null : (
									<text
										attributes={
											isContextWarning ? undefined : TextAttributes.DIM
										}
										fg={isContextWarning ? colors.error : undefined}
									>{`${usage.contextPercent}% used`}</text>
								)}
								{usage.costUsd === null ? null : (
									<text attributes={TextAttributes.DIM}>
										{`${formatUsdAmount(usage.costUsd)} spent`}
									</text>
								)}
							</>
						) : (
							<text attributes={TextAttributes.DIM}>No usage yet</text>
						)}
					</box>

					<box flexDirection="column">
						<SectionLabel text="Agents" />
						{codingModes.map((codingMode) => (
							<box
								flexDirection="row"
								justifyContent="space-between"
								key={codingMode.value}
								width="100%"
							>
								<text attributes={TextAttributes.DIM}>
									{codingMode.displayName.toLowerCase()}
								</text>
								<text attributes={TextAttributes.DIM}>
									{modelLabel.toLowerCase()}
								</text>
							</box>
						))}
					</box>
				</box>
			</scrollbox>

			<box flexDirection="column" flexShrink={0} gap={1}>
				<WorkspacePath />
				<text>
					<span fg={colors.primary}>{"• "}</span>
					<span attributes={TextAttributes.DIM}>Win</span>
					<b>Code</b>
					<span attributes={TextAttributes.DIM}>{` ${APP_VERSION}`}</span>
				</text>
			</box>
		</box>
	);
}
