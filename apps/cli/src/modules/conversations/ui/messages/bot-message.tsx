import { TextAttributes } from "@opentui/core";
import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	findSupportedChatModelSelection,
	normalizeChatModelSelection,
} from "@wincode/ai";
import { connectionProviderDisplayNames } from "@/modules/connections";
import { EmptyBorder } from "@/shared/constants";
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

const groupConsecutiveParts = (parts: MessagePart[]): PartGroup[] => {
	const groups: PartGroup[] = [];

	for (const [index, part] of parts.entries()) {
		const lastGroup = groups.at(-1);

		if (lastGroup && lastGroup.type === part.type) {
			lastGroup.parts.push(part);
			continue;
		}

		const key = isToolPart(part)
			? `group-tc-${formatUnknown(part.toolCallId) || index}`
			: `group-${part.type}-${index}`;

		groups.push({ key, parts: [part], type: part.type });
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
			label:
				findSupportedChatModelSelection(selection)?.displayName ??
				selection.modelId,
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
		items.push({ color: colors.dimSeparator, label });
		if (providerId) {
			items.push({
				color: colors.dimSeparator,
				label: connectionProviderDisplayNames[providerId],
				separator: "space",
			});
		}
	}

	if (metadata.responseTimeMs !== undefined) {
		items.push({
			color: colors.dimSeparator,
			label: formatResponseTime(metadata.responseTimeMs),
		});
	}

	if (metadata.interrupted === true) {
		items.push({ color: colors.dimSeparator, label: "interrupted" });
	}

	return items;
};

export function BotMessage({
	message,
	parts,
}: {
	message: CodingAgentUIMessage;
	parts: CodingAgentUIMessage["parts"];
}) {
	return (
		<>
			<BotMessageContent parts={parts} />
			<box paddingTop={1} width="100%">
				<BotMessageFooter message={message} />
			</box>
		</>
	);
}

export function BotMessageContent({
	parts,
}: {
	parts: CodingAgentUIMessage["parts"];
}) {
	const { colors } = useTheme();

	return (
		<box alignItems="center" width="100%">
			{groupConsecutiveParts(parts).map((group, groupIndex) => (
				<box key={group.key} paddingTop={groupIndex === 0 ? 0 : 1} width="100%">
					{group.parts.map((part) => {
						if (part.type === "reasoning") {
							return (
								<box
									border={["left"]}
									borderColor={colors.thinkingBorder}
									customBorderChars={{
										...EmptyBorder,
										vertical: "│",
									}}
									key={`reasoning-${part.text}`}
									paddingX={2}
									width="100%"
								>
									<text attributes={TextAttributes.DIM}>
										<em fg={colors.thinking}>Thinking:</em> {part.text}
									</text>
								</box>
							);
						}

						if (isToolPart(part)) {
							const state = formatUnknown(part.state);
							const isInProgress =
								state !== "output-available" && state !== "output-error";
							const errorText = formatUnknown(part.errorText);
							const toolKey =
								formatUnknown(part.toolCallId) ||
								`tool-${getToolName(part)}-${state}-${formatToolArgs(part)}-${errorText}`;

							return (
								<box
									border={["left"]}
									borderColor={colors.thinkingBorder}
									customBorderChars={{
										...EmptyBorder,
										vertical: "│",
									}}
									key={toolKey}
									paddingX={2}
									width="100%"
								>
									<text attributes={TextAttributes.DIM}>
										<em fg={colors.info}>
											{formatToolName(getToolName(part))}:
										</em>{" "}
										{formatToolArgs(part)}
										{isInProgress ? " …" : ""}
										{state === "output-error" ? ` ${errorText}` : ""}
									</text>
								</box>
							);
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
						{renderFooterSeparator(index, item, colors.dimSeparator)}
						<span fg={item.color}>{item.label}</span>
					</span>
				))}
			</text>
		</box>
	);
}
