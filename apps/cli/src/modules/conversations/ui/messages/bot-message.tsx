import type { BoxRenderable } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import {
	boundCommandHeader,
	boundPreview,
	computeContentWidth,
	formatAgent,
	formatMcpToolName,
	formatModel,
	formatResponseTime,
	formatSkillHash,
	formatToolName,
	formatUnknown,
	isSensitiveKey,
	REDACTED,
	resolveOverflowIndicator,
	SHELL_BLOCK_PADDING_X,
	sanitizeArgumentTree,
	sanitizeShellOutput,
	sanitizeText,
	stripControlCharacters,
} from "@/shared/display-sanitize";
import { ToolApprovalPanel } from "@/shared/providers/approval/ui/tool-approval-panel";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { ConversationBlock } from "./conversation-block";
import { EditDiffBlock } from "./edit-diff-block";
import { MarkdownMessagePart } from "./markdown-message-part";

type MessagePart = CodingAgentUIMessage["parts"][number];
type ToolPart = Extract<
	MessagePart,
	{ type: `tool-${string}` | "dynamic-tool" }
>;

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

const MAX_TOOL_ARGUMENTS_LENGTH = 512;
const MAX_TOOL_ARGUMENT_ENTRIES = 12;

const getToolInputRecord = (part: ToolPart): Record<string, unknown> =>
	typeof part.input === "object" &&
	part.input !== null &&
	!Array.isArray(part.input)
		? (part.input as Record<string, unknown>)
		: {};

const getToolOutputRecord = (part: ToolPart): Record<string, unknown> =>
	typeof part.output === "object" &&
	part.output !== null &&
	!Array.isArray(part.output)
		? (part.output as Record<string, unknown>)
		: {};

const formatToolArgumentValue = (value: unknown): string => {
	const sanitized = sanitizeArgumentTree(value);
	return formatUnknown(sanitized).slice(0, MAX_TOOL_ARGUMENTS_LENGTH);
};

const formatMcpToolArgs = (part: ToolPart): string => {
	if (
		typeof part.input !== "object" ||
		part.input === null ||
		Array.isArray(part.input)
	) {
		return formatToolArgumentValue(part.input);
	}

	const input = part.input as Record<string, unknown>;
	const formatted = Object.keys(input)
		.slice(0, MAX_TOOL_ARGUMENT_ENTRIES)
		.map(
			(key) =>
				`${stripControlCharacters(key, MAX_TOOL_ARGUMENTS_LENGTH)}=${
					isSensitiveKey(key) ? REDACTED : formatToolArgumentValue(input[key])
				}`
		)
		.join(", ");
	return formatted.length <= MAX_TOOL_ARGUMENTS_LENGTH
		? formatted
		: `${formatted.slice(0, MAX_TOOL_ARGUMENTS_LENGTH)}…`;
};

const formatStaticToolSummary = (name: string, part: ToolPart): string => {
	const input = getToolInputRecord(part);
	const path =
		typeof input.path === "string"
			? stripControlCharacters(input.path, MAX_TOOL_ARGUMENTS_LENGTH)
			: ".";
	if (name === "grep") {
		const pattern = stripControlCharacters(
			JSON.stringify(formatToolArgumentValue(input.pattern)),
			MAX_TOOL_ARGUMENTS_LENGTH
		);
		return `✱ Grep ${pattern} in ${path}`;
	}
	if (name === "shell") {
		const command = stripControlCharacters(
			typeof input.command === "string" ? input.command : "",
			MAX_TOOL_ARGUMENTS_LENGTH
		);
		return `$ ${command}`;
	}
	if (name === "read") {
		return `→ Read ${path}`;
	}
	if (name === "write") {
		return `→ Write ${path}`;
	}
	if (name === "edit") {
		return `→ Edit ${path}`;
	}
	if (name === "list") {
		return `→ List ${path}`;
	}
	return `✱ ${formatToolName(name)} ${formatToolArgumentValue(part.input)}`;
};

const isToolPart = (part: MessagePart): part is ToolPart =>
	part.type === "dynamic-tool" || part.type.startsWith("tool-");

const getToolName = (part: ToolPart) => {
	if (part.type === "dynamic-tool") {
		return formatUnknown(part.toolName) || "dynamic-tool";
	}

	return part.type.slice("tool-".length);
};

const getToolKey = (part: ToolPart, index: number) => {
	const state = formatUnknown(part.state);
	const errorText = stripControlCharacters(
		formatUnknown(part.errorText),
		MAX_TOOL_ARGUMENTS_LENGTH
	);

	return `${formatUnknown(part.toolCallId) || `tool-${getToolName(part)}-${state}-${errorText}`}-${index}`;
};

const getContentPartKey = (
	part: Extract<MessagePart, { type: "reasoning" | "text" }>,
	index: number
): string => `${part.type}-${index}`;

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

	if (metadata.agent) {
		items.push({
			color: getAgentColor(colors, metadata.agent),
			label: formatAgent(metadata.agent),
		});
	}

	const model = metadata.model;
	if (model) {
		const {
			label,
			// providerId
		} = formatModel(model);
		items.push({ color: colors.textMuted, label });
		// if (providerId) {
		// 	items.push({
		// 		color: colors.textMuted,
		// 		label: connectionProviderDisplayNames[providerId],
		// 		separator: "space",
		// 	});
		// }
	}

	if (metadata.responseTimeMs !== undefined) {
		items.push({
			color: colors.textMuted,
			label: formatResponseTime(metadata.responseTimeMs),
		});
	}

	if (metadata.interrupted === true) {
		items.push({ color: colors.warning, label: "interrupted" });
	}

	return items;
};

function ToolMessagePart({ part }: { part: ToolPart }) {
	const { colors } = useTheme();
	const isSkillCall =
		part.type === "dynamic-tool" &&
		part.toolName === "skill" &&
		(part.state === "output-available" || part.state === "output-error");
	const isShellOutput =
		part.type === "tool-shell" && part.state === "output-available";
	const isEditOutput =
		part.type === "tool-edit" &&
		part.state === "output-available" &&
		"editDiff" in getToolOutputRecord(part);

	let toolLine: ReactNode = <ToolCallLine colors={colors} part={part} />;
	if (isSkillCall) {
		toolLine = <SkillActivityRow part={part} />;
	} else if (isShellOutput || isEditOutput) {
		// Specialized blocks group their own successful tool header.
		toolLine = null;
	}

	return (
		<>
			{toolLine}
			{isShellOutput ? <ShellOutputBlock part={part} /> : null}
			{isEditOutput ? <EditDiffBlock part={part} /> : null}
			{typeof part.toolCallId === "string" ? (
				<ToolApprovalPanel id={part.toolCallId} />
			) : null}
		</>
	);
}

const MemoizedToolMessagePart = memo(ToolMessagePart);

/**
 * The themed conversation block for a completed `shell` call: the bounded
 * command header, execution status, and a preview of the beginning of the
 * sanitized result. Collapsed output is bounded to six visual rows measured
 * against the block's content width, and only overflowing blocks are
 * expandable; clicking the block toggles between the preview and the full
 * bounded result. Sanitization and preview layout are memoized on the raw
 * output and the measured width, so streamed updates of neighboring parts
 * never re-sanitize or re-lay-out settled results.
 */
function ShellOutputBlock({ part }: { part: ToolPart }) {
	const { colors } = useTheme();
	const blockRef = useRef<BoxRenderable>(null);
	const [contentWidth, setContentWidth] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const output = getToolOutputRecord(part);
	const rawText = formatUnknown(output.output);
	const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
	const timedOut = output.timedOut === true;
	const truncated = output.truncated === true;
	const command = stripControlCharacters(
		formatUnknown(getToolInputRecord(part).command),
		MAX_TOOL_ARGUMENTS_LENGTH
	);

	const sanitizedText = useMemo(() => sanitizeShellOutput(rawText), [rawText]);
	const preview = useMemo(
		() => boundPreview(sanitizedText, contentWidth),
		[sanitizedText, contentWidth]
	);
	const header = useMemo(
		() => boundCommandHeader(command, contentWidth),
		[command, contentWidth]
	);
	const indicator = resolveOverflowIndicator(preview);
	const canExpand = preview.hasOverflow;

	// The measured content width drives preview wrapping and the header bound.
	// Reflowing on real size changes (terminal resize, sidebar toggle) keeps the
	// collapsed preview bounded while never touching the expansion state.
	const handleBlockResize = () => {
		const width = blockRef.current?.width ?? 0;
		if (width <= 0) {
			return;
		}
		const measured = computeContentWidth(width);
		queueMicrotask(() => {
			setContentWidth((current) => (current === measured ? current : measured));
		});
	};

	const markers = [
		exitCode === null ? null : `exit ${exitCode}`,
		timedOut ? "timed out" : null,
		truncated ? "truncated" : null,
	]
		.filter((marker): marker is string => marker !== null)
		.join(" · ");
	const hasFailed = (exitCode !== null && exitCode !== 0) || timedOut;

	return (
		<ConversationBlock
			blockRef={blockRef}
			colors={colors}
			onMouseDown={() => {
				if (canExpand) {
					setExpanded((value) => !value);
				}
			}}
			onSizeChange={handleBlockResize}
			paddingX={SHELL_BLOCK_PADDING_X}
		>
			<text fg={colors.text} wrapMode="char">
				{header}
			</text>
			{markers.length > 0 ? (
				<text fg={hasFailed ? colors.error : colors.textMuted}>{markers}</text>
			) : null}
			<text fg={colors.text} wrapMode="char">
				{expanded ? sanitizedText : preview.text}
			</text>
			{expanded || indicator === null ? null : (
				<text fg={colors.textMuted}>{indicator}</text>
			)}
		</ConversationBlock>
	);
}

function ToolCallLine({
	colors,
	part,
}: {
	colors: ReturnType<typeof useTheme>["colors"];
	part: ToolPart;
}) {
	const errorText = sanitizeText(formatUnknown(part.errorText));
	const isMcpTool = part.type === "dynamic-tool";
	const name = getToolName(part);
	const label = isMcpTool ? formatMcpToolName(name) : formatToolName(name);
	const hasFailed = part.state === "output-error";
	const wasDenied = part.state === "output-denied";
	const staticSummary = formatStaticToolSummary(name, part);

	return (
		<box marginBottom={1} paddingX={3} width="100%">
			{isMcpTool ? (
				<text fg={colors.tool}>
					{`⚙ ${label} [${formatMcpToolArgs(part)}]`}
					{hasFailed && !errorText ? (
						<span fg={colors.error}> failed</span>
					) : null}
					{wasDenied ? <span fg={colors.textMuted}> denied</span> : null}
					{errorText ? <span fg={colors.error}>{` ${errorText}`}</span> : null}
				</text>
			) : (
				<text fg={colors.tool}>
					{staticSummary}
					{hasFailed && !errorText ? (
						<span fg={colors.error}> failed</span>
					) : null}
					{wasDenied ? <span fg={colors.textMuted}> denied</span> : null}
					{errorText ? <span fg={colors.error}>{` ${errorText}`}</span> : null}
				</text>
			)}
		</box>
	);
}

type SkillActivityState =
	| "already-loaded"
	| "approval-requested"
	| "failed"
	| "limit-reached"
	| "loaded"
	| "rejected";

const SKILL_ACTIVITY_LABELS: Record<SkillActivityState, string> = {
	"already-loaded": "already loaded",
	"approval-requested": "requesting approval",
	failed: "failed",
	"limit-reached": "limit reached",
	loaded: "loaded",
	rejected: "rejected",
};

/**
 * The audit row for one Agent-driven Skill activation: name, source, state,
 * and a short content hash identify the exact snapshot without ever rendering
 * the instructions. The state is derived from the sanitized tool result, so
 * the same row renders from live memory and from durable history.
 */
function SkillActivityRow({ part }: { part: ToolPart }) {
	const { colors } = useTheme();
	const output =
		part.state === "output-available" &&
		typeof part.output === "object" &&
		part.output !== null &&
		!Array.isArray(part.output)
			? (part.output as Record<string, unknown>)
			: undefined;
	const status = formatUnknown(output?.status) as SkillActivityState;
	const stateLabel = SKILL_ACTIVITY_LABELS[status] ?? formatToolName(status);
	const name = stripControlCharacters(
		formatUnknown(output?.name ?? (part.input as { name?: unknown })?.name),
		64
	);
	const source =
		output?.source === "explicit" || output?.source === "agent"
			? output.source
			: undefined;
	const hash = formatSkillHash(output?.contentHash);
	const failed =
		status === "failed" || part.state === "output-error"
			? stripControlCharacters(
					formatUnknown(output?.error ?? part.errorText),
					MAX_TOOL_ARGUMENTS_LENGTH
				)
			: "";
	const activeNames =
		status === "limit-reached" && Array.isArray(output?.activeSkillNames)
			? ` · ${output.activeSkillNames.join(", ")}`
			: "";

	return (
		<box marginBottom={1} paddingX={3} width="100%">
			<text fg={colors.tool}>
				{`◆ Skill ${name || "?"} — ${stateLabel}`}
				{source ? <span fg={colors.textMuted}>{` · ${source}`}</span> : null}
				{hash ? <span fg={colors.textMuted}>{` · ${hash}`}</span> : null}
				{activeNames ? <span fg={colors.textMuted}>{activeNames}</span> : null}
				{failed ? <span fg={colors.error}>{` · ${failed}`}</span> : null}
			</text>
		</box>
	);
}

export function BotMessageContent({
	isStreaming = false,
	parts,
}: {
	/**
	 * True while the message's text parts can still grow. Keeps the markdown
	 * mapping in streaming mode so trailing blocks parse incrementally
	 * instead of re-parsing from scratch on every token delta.
	 */
	isStreaming?: boolean;
	parts: CodingAgentUIMessage["parts"];
}) {
	const { colors } = useTheme();
	const groups = groupConsecutiveParts(parts);

	return (
		<box alignItems="center" width="100%">
			{groups.map((group, groupIndex) => (
				<box
					key={group.key}
					paddingTop={
						groups[groupIndex - 1]?.type === "text" &&
						group.parts[0]?.type === "tool-shell" &&
						group.parts[0].state === "output-available"
							? 1
							: 0
					}
					width="100%"
				>
					{group.parts.map((part, index) => {
						if (part.type === "reasoning") {
							return (
								<box
									key={getContentPartKey(part, index)}
									marginBottom={1}
									paddingX={3}
									width="100%"
								>
									<text fg={colors.thinkingText}>
										<em fg={colors.thinking}>Thinking:</em> {part.text}
									</text>
								</box>
							);
						}

						if (isToolPart(part)) {
							return (
								<MemoizedToolMessagePart
									key={getToolKey(part, index)}
									part={part}
								/>
							);
						}

						if (part.type === "text") {
							return (
								<MarkdownMessagePart
									isStreaming={isStreaming}
									key={getContentPartKey(part, index)}
									text={part.text}
								/>
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
