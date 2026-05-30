import { TextAttributes } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useTheme } from "../../../providers/theme";
import { EmptyBorder } from "../../border";

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

const CAMEL_CASE_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g;
const FIRST_CHARACTER_REGEX = /^./;

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

export function BotMessage({
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
