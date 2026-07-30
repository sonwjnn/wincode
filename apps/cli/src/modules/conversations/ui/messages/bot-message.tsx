import { TextAttributes } from "@opentui/core";
import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	findSupportedChatModelSelection,
	formatModelLabel,
	normalizeChatModelSelection,
} from "@wincode/ai";
import { connectionProviderDisplayNames } from "@/modules/connections";
import { useTheme } from "@/shared/providers/theme/theme-provider";

type MessagePart = CodingAgentUIMessage["parts"][number];
type ToolPart = MessagePart & {
	errorText?: unknown;
	input?: unknown;
	state?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	type: `tool-${string}` | "dynamic-tool";
};

type PartGroup = {
	isToolGroup: boolean;
	key: string;
	parts: MessagePart[];
	type: MessagePart["type"];
};

type FooterItem = {
	color: string;
	label: string;
	separator?: "dot" | "space";
};

const CAMEL_CASE_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g;
const FIRST_CHARACTER_REGEX = /^./;
const FOOTER_ICON = "▣";
const formatUnknown = (value: unknown) => {
	if (value === undefined || value === null) {
		return "";
	}

	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const formatToolName = (name: string) =>
	name
		.replace(CAMEL_CASE_BOUNDARY_REGEX, "$1 $2")
		.replace(FIRST_CHARACTER_REGEX, (character) => character.toUpperCase());

const isToolPart = (part: MessagePart): part is ToolPart =>
	part.type === "dynamic-tool" || part.type.startsWith("tool-");

const formatToolArgs = (part: ToolPart) => formatUnknown(part.input);

const getToolName = (part: ToolPart) => {
	if (part.type === "dynamic-tool") {
		return formatUnknown(part.toolName) || "dynamic-tool";
	}

	return part.type.slice("tool-".length);
};

const getToolKey = (part: ToolPart) => {
	const state = formatUnknown(part.state);
	const errorText = formatUnknown(part.errorText);

	return (
		formatUnknown(part.toolCallId) ||
		`tool-${getToolName(part)}-${state}-${formatToolArgs(part)}-${errorText}`
	);
};

const groupConsecutiveParts = (parts: MessagePart[]): PartGroup[] => {
	const groups: PartGroup[] = [];

	for (const [index, part] of parts.entries()) {
		const lastGroup = groups.at(-1);
		const isCurrentPartTool = isToolPart(part);

		if (
			lastGroup &&
			(lastGroup.type === part.type ||
				(lastGroup.isToolGroup && isCurrentPartTool))
		) {
			lastGroup.parts.push(part);
			continue;
		}

		const key = isCurrentPartTool
			? `group-tc-${formatUnknown(part.toolCallId) || index}`
			: `group-${part.type}-${index}`;

		groups.push({
			isToolGroup: isCurrentPartTool,
			key,
			parts: [part],
			type: part.type,
		});
	}

	return groups;
};

export const formatResponseTime = (responseTimeMs: number) => {
	if (responseTimeMs < 1000) {
		return `${responseTimeMs}ms`;
	}

	const totalSeconds = Math.round(responseTimeMs / 1000);
	if (totalSeconds < 60) {
		return `${(responseTimeMs / 1000).toFixed(1)}s`;
	}

	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
};

const formatMode = (mode: string) =>
	`${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;

const formatModel = (model: string | ChatModelSelection) => {
	const selection = normalizeChatModelSelection(model);
	if (selection) {
		return {
			label: formatModelLabel(
				findSupportedChatModelSelection(selection)?.displayName ??
					selection.modelId
			),
			providerId: selection.providerId,
		};
	}

	if (typeof model === "string") {
		return { label: model, providerId: undefined };
	}

	return { label: model.modelId, providerId: model.providerId };
};

const renderFooterSeparator = (
	index: number,
	item: FooterItem,
	color: string
) => {
	if (index === 0) {
		return null;
	}

	return item.separator === "space" ? " " : <span fg={color}> · </span>;
};

const resolveFooterItems = (
	message: CodingAgentUIMessage,
	colors: ReturnType<typeof useTheme>["colors"]
): FooterItem[] => {
	const metadata = message.metadata;
	if (!metadata) {
		return [];
	}

	const items: FooterItem[] = [];

	if (metadata.mode) {
		items.push({
			color: colors.mode[metadata.mode],
			label: formatMode(metadata.mode),
		});
	}

	const model = metadata.model;
	if (model) {
		const { label, providerId } = formatModel(model);
		items.push({ color: colors.textMuted, label });
		if (providerId) {
			items.push({
				color: colors.textMuted,
				label: connectionProviderDisplayNames[providerId],
				separator: "space",
			});
		}
	}

	if (metadata.responseTimeMs !== undefined) {
		items.push({
			color: colors.textMuted,
			label: formatResponseTime(metadata.responseTimeMs),
		});
	}

	if (metadata.interrupted === true) {
		items.push({ color: colors.textMuted, label: "interrupted" });
	}

	return items;
};

function ToolMessagePart({ part }: { part: ToolPart }) {
	const { colors } = useTheme();
	const state = formatUnknown(part.state);
	const isInProgress = state !== "output-available" && state !== "output-error";
	const errorText = formatUnknown(part.errorText);

	return (
		<box marginBottom={1} paddingX={3} width="100%">
			<text attributes={TextAttributes.DIM}>
				<em fg={colors.info}>{formatToolName(getToolName(part))}:</em>{" "}
				{formatToolArgs(part)}
				{isInProgress ? " …" : ""}
				{state === "output-error" ? ` ${errorText}` : ""}
			</text>
		</box>
	);
}

export function BotMessageContent({
	parts,
}: {
	parts: CodingAgentUIMessage["parts"];
}) {
	const { colors } = useTheme();
	const groups = groupConsecutiveParts(parts);

	return (
		<box alignItems="center" width="100%">
			{groups.map((group) => (
				<box key={group.key} width="100%">
					{group.parts.map((part) => {
						if (part.type === "reasoning") {
							return (
								<box
									key={`reasoning-${part.text}`}
									marginBottom={1}
									paddingX={3}
									width="100%"
								>
									<text attributes={TextAttributes.DIM}>
										<em fg={colors.thinking}>Thinking:</em> {part.text}
									</text>
								</box>
							);
						}

						if (isToolPart(part)) {
							return <ToolMessagePart key={getToolKey(part)} part={part} />;
						}

						if (part.type === "text") {
							return (
								<box key={`text-${part.text}`} paddingX={3} width="100%">
									<text>{part.text}</text>
								</box>
							);
						}

						return null;
					})}
				</box>
			))}
		</box>
	);
}

export function BotMessageFooter({
	message,
}: {
	message: CodingAgentUIMessage;
}) {
	const { colors } = useTheme();
	const footerItems = resolveFooterItems(message, colors);

	if (footerItems.length === 0) {
		return null;
	}

	return (
		<box paddingX={3} width="100%">
			<text>
				<span fg={colors.primary}>{FOOTER_ICON}</span>{" "}
				{footerItems.map((item, index) => (
					<span key={`${item.color}-${item.label}`}>
						{renderFooterSeparator(index, item, colors.textMuted)}
						<span fg={item.color}>{item.label}</span>
					</span>
				))}
			</text>
		</box>
	);
}
