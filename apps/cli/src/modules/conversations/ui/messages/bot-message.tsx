import type { BoxRenderable } from "@opentui/core";
import type { AgentId } from "@wincode/agent-core";
import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import { buildAgent } from "@/modules/agents";
import type { ConversationMessage } from "@/modules/conversations/message";
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
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import { ToolApprovalPanel } from "@/shared/providers/approval/ui/tool-approval-panel";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	getAgentColor,
	type ThemeColors,
} from "@/shared/providers/theme/themes";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { Spinner } from "@/shared/ui/spinner";
import { EditDiffBlock } from "./edit-diff-block";
import { MarkdownMessagePart } from "./markdown-message-part";
import { isRenderableWritePart, WriteBlock } from "./write-block";

type MessagePart = ConversationMessage["parts"][number];
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

const getToolResource = (part: ToolPart): string | undefined => {
	const input = getToolInputRecord(part);
	if (part.type === "tool-shell") {
		return typeof input.command === "string" ? input.command : undefined;
	}
	if (part.type === "tool-grep" || part.type === "tool-glob") {
		return typeof input.pattern === "string" ? input.pattern : undefined;
	}
	const path = typeof input.path === "string" ? input.path : undefined;
	return path;
};

/**
 * The failure reason without the `: resource` identity suffix: the tool row
 * above already shows the path/command/pattern, so the error line never
 * repeats it. Non-gate wording (interruptions, MCP errors) has no such suffix
 * and passes through unchanged.
 */
const stripErrorResource = (errorText: string, part: ToolPart): string => {
	const resource = getToolResource(part);
	return resource === undefined
		? errorText
		: errorText.replace(`: ${resource}`, "");
};

/**
 * The live failure reason of a `skill` activation: the runtime result carries
 * `output.status === "failed"` with the error before persistence collapses it
 * to an `output-error` part with `errorText`.
 */
const getSkillFailedError = (part: ToolPart): string => {
	if (
		part.type !== "dynamic-tool" ||
		part.toolName !== "skill" ||
		part.state !== "output-available"
	) {
		return "";
	}
	const output = getToolOutputRecord(part);
	return formatUnknown(output.status) === "failed"
		? formatUnknown(output.error)
		: "";
};

/**
 * The failure reason for the fallback error line, or "" when none renders:
 * denied calls are owned by the audit line, and non-failed parts carry no
 * error. Live skill failures surface their reason through the sanitized
 * output result, every other failure through `errorText`.
 */
const getFallbackError = (part: ToolPart, auditOwnsError: boolean): string => {
	if (auditOwnsError) {
		return "";
	}
	const skillError = getSkillFailedError(part);
	if (part.state !== "output-error" && skillError === "") {
		return "";
	}
	return stripErrorResource(
		sanitizeText(formatUnknown(part.errorText) || skillError),
		part
	);
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

const formatStaticToolSummary = (
	name: string,
	part: ToolPart,
	isRunning = false
): string => {
	const input = getToolInputRecord(part);
	const path =
		typeof input.path === "string"
			? stripControlCharacters(input.path, MAX_TOOL_ARGUMENTS_LENGTH)
			: "";
	const pathSuffix = path ? ` ${path}` : "";
	const pathOrCurrentDirectory = path || ".";
	if (name === "grep" || name === "glob") {
		const pattern = stripControlCharacters(
			JSON.stringify(formatToolArgumentValue(input.pattern)),
			MAX_TOOL_ARGUMENTS_LENGTH
		);
		return `✱ ${formatToolName(name)} ${pattern} in ${pathOrCurrentDirectory}`;
	}
	if (name === "shell") {
		const command = stripControlCharacters(
			typeof input.command === "string" ? input.command : "",
			MAX_TOOL_ARGUMENTS_LENGTH
		);
		return `$ ${command}`;
	}
	if (name === "read") {
		return `${isRunning ? "" : "→ "}Read${pathSuffix}`;
	}
	if (name === "write") {
		return `${isRunning ? "" : "→ "}Write${pathSuffix}`;
	}
	if (name === "edit") {
		return `${isRunning ? "" : "→ "}Edit${pathSuffix}`;
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
	const lifecycleState = part.type === "tool-edit" ? `-${state}` : "";

	return `${formatUnknown(part.toolCallId) || `tool-${getToolName(part)}-${state}-${errorText}`}${lifecycleState}-${index}`;
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
	message: ConversationMessage,
	colors: ThemeColors
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

function ToolMessagePart({ agent, part }: { agent: AgentId; part: ToolPart }) {
	const { colors } = useTheme();
	const { entries } = useApprovalPanels();
	// The denied approval audit line (`✗`) already renders the failure reason
	// for gated calls; every other failed call gets the fallback error line
	// below. Either way the error text never renders on the tool row itself.
	const auditOwnsError = entries.some(
		(entry) =>
			entry.id === part.toolCallId &&
			(entry.resolution?.outcome === "aborted" ||
				entry.resolution?.outcome === "rejected")
	);
	const fallbackError = getFallbackError(part, auditOwnsError);
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
	const isEditRunning =
		part.type === "tool-edit" &&
		(part.state === "input-streaming" || part.state === "input-available");
	const isEditPreview = isEditRunning || isEditOutput;
	const isWritePreview =
		part.type === "tool-write" &&
		(part.state === "input-streaming" ||
			part.state === "input-available" ||
			isRenderableWritePart(part));

	let toolLine: ReactNode = (
		<ToolCallLine agent={agent} colors={colors} part={part} />
	);
	if (isSkillCall) {
		toolLine = <SkillActivityRow part={part} />;
	} else if (isShellOutput || isEditPreview || isWritePreview) {
		// Specialized blocks group their own tool header.
		toolLine = null;
	}

	return (
		<>
			{toolLine}
			{isShellOutput ? <ShellOutputBlock part={part} /> : null}
			{isEditPreview ? <EditDiffBlock agent={agent} part={part} /> : null}
			{isWritePreview ? <WriteBlock agent={agent} part={part} /> : null}
			{typeof part.toolCallId === "string" ? (
				<ToolApprovalPanel
					errorText={
						part.state === "output-error"
							? sanitizeText(formatUnknown(part.errorText))
							: undefined
					}
					id={part.toolCallId}
					mode="resolved-only"
				/>
			) : null}
			{fallbackError === "" ? null : (
				<box marginBottom={1} paddingX={3} width="100%">
					<text fg={colors.error}>{`✗ ${fallbackError}`}</text>
				</box>
			)}
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
		<BorderedContentBlock
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
			<text fg={hasFailed ? colors.error : colors.text} wrapMode="char">
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
		</BorderedContentBlock>
	);
}

function ToolCallLine({
	agent,
	colors,
	part,
}: {
	agent: AgentId;
	colors: ThemeColors;
	part: ToolPart;
}) {
	const errorText = sanitizeText(formatUnknown(part.errorText));
	const isMcpTool = part.type === "dynamic-tool";
	const name = getToolName(part);
	const label = isMcpTool ? formatMcpToolName(name) : formatToolName(name);
	const hasFailed = part.state === "output-error";
	const isReadTool = name === "read";
	const wasDenied = part.state === "output-denied";
	const hasFailure = hasFailed || wasDenied;
	const isRunning =
		part.state === "input-streaming" || part.state === "input-available";
	const toolColor = hasFailure ? colors.error : colors.tool;
	const staticSummary = formatStaticToolSummary(name, part, isRunning);
	const toolContent = isMcpTool ? (
		<text fg={toolColor} flexGrow={1} flexShrink={1} wrapMode="char">
			{`⚙ ${label} [${formatMcpToolArgs(part)}]`}
			{hasFailed && !errorText ? <span fg={colors.error}> failed</span> : null}
			{wasDenied ? <span fg={toolColor}> denied</span> : null}
		</text>
	) : (
		<text fg={toolColor} flexGrow={1} flexShrink={1} wrapMode="char">
			{staticSummary}
			{wasDenied ? <span fg={toolColor}> denied</span> : null}
		</text>
	);

	if (!isRunning) {
		return (
			<box marginBottom={1} paddingX={3} width="100%">
				{toolContent}
			</box>
		);
	}
	if (isMcpTool || isReadTool) {
		return (
			<box
				alignItems="center"
				flexDirection="row"
				gap={1}
				marginBottom={1}
				paddingX={3}
				width="100%"
			>
				<Spinner agent={agent} />
				<box flexGrow={1} flexShrink={1} width="100%">
					{toolContent}
				</box>
			</box>
		);
	}

	return (
		<BorderedContentBlock colors={colors} paddingX={2}>
			<box alignItems="center" flexDirection="row" gap={1} width="100%">
				<Spinner agent={agent} />
				<box flexGrow={1} flexShrink={1} width="100%">
					{toolContent}
				</box>
			</box>
		</BorderedContentBlock>
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
			</text>
		</box>
	);
}

export function BotMessageContent({
	agent = buildAgent.id,
	parts,
}: {
	/** The agent that produced the message; drives the running-tool spinner color. */
	agent?: AgentId;
	parts: ConversationMessage["parts"];
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
									agent={agent}
									key={getToolKey(part, index)}
									part={part}
								/>
							);
						}

						if (part.type === "text") {
							return (
								<MarkdownMessagePart
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
	message: ConversationMessage;
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
