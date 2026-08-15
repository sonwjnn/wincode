import type { BoxRenderable } from "@opentui/core";
import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	findSupportedChatModelSelection,
	formatModelLabel,
	normalizeChatModelSelection,
	SHELL_OUTPUT_TAIL_BYTES,
} from "@wincode/ai";
import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import { connectionProviderDisplayNames } from "@/modules/connections";
import { EmptyBorder } from "@/shared/constants";
import { ToolApprovalPanel } from "@/shared/providers/approval/ui/tool-approval-panel";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";

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

const CAMEL_CASE_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g;
const FIRST_CHARACTER_REGEX = /^./;
const FOOTER_ICON = "▣";
const MCP_QUALIFIED_TOOL_NAME_REGEX = /^(.+_.+)_[a-f\d]{8}$/i;
const MCP_TOOL_PREFIX = "mcp_";
const MAX_TOOL_ARGUMENTS_LENGTH = 512;
const MAX_TOOL_ARGUMENT_ENTRIES = 12;
const MAX_TOOL_ARGUMENT_DEPTH = 2;
const REDACTED_TOOL_ARGUMENT = "[redacted]";
const SENSITIVE_TOOL_ARGUMENT_KEY_REGEX =
	/(?:apikey|auth|authorization|bearer|cookie|credential|password|privatekey|secret|session|token)/i;
const SENSITIVE_TOOL_ARGUMENT_VALUE_REGEX =
	/\b(?:(?:api[ _-]?key|auth(?:orization)?|cookie|credential|password|private[ _-]?key|secret|session|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;}\]]+|bearer\s+[^\s,;}\]]+)/gi;
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

const formatMcpToolName = (name: string): string => {
	const logicalName = name.startsWith(MCP_TOOL_PREFIX)
		? name.slice(MCP_TOOL_PREFIX.length)
		: name;
	return MCP_QUALIFIED_TOOL_NAME_REGEX.exec(logicalName)?.[1] ?? logicalName;
};

const sanitizeDisplayText = (
	value: string,
	maxLength = MAX_TOOL_ARGUMENTS_LENGTH
): string =>
	Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	})
		.join("")
		.slice(0, maxLength);

const redactSensitiveDisplayText = (value: string): string =>
	value.replace(SENSITIVE_TOOL_ARGUMENT_VALUE_REGEX, REDACTED_TOOL_ARGUMENT);

const isSensitiveToolArgumentKey = (key: string): boolean =>
	SENSITIVE_TOOL_ARGUMENT_KEY_REGEX.test(
		sanitizeDisplayText(key).replace(/[^a-z0-9]/gi, "")
	);

const sanitizeToolArgumentValue = (
	value: unknown,
	depth: number,
	seen: WeakSet<object>
): unknown => {
	if (typeof value === "string") {
		return redactSensitiveDisplayText(sanitizeDisplayText(value));
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (seen.has(value)) {
		return "[circular]";
	}
	if (depth >= MAX_TOOL_ARGUMENT_DEPTH) {
		return "[…]";
	}

	seen.add(value);
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_TOOL_ARGUMENT_ENTRIES)
			.map((entry) => sanitizeToolArgumentValue(entry, depth + 1, seen));
	}

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).slice(0, MAX_TOOL_ARGUMENT_ENTRIES)) {
		result[sanitizeDisplayText(key)] = isSensitiveToolArgumentKey(key)
			? REDACTED_TOOL_ARGUMENT
			: sanitizeToolArgumentValue(
					(value as Record<string, unknown>)[key],
					depth + 1,
					seen
				);
	}
	return result;
};

const formatToolArgumentValue = (value: unknown): string => {
	const sanitized = sanitizeToolArgumentValue(value, 0, new WeakSet());
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
				`${sanitizeDisplayText(key)}=${
					isSensitiveToolArgumentKey(key)
						? REDACTED_TOOL_ARGUMENT
						: formatToolArgumentValue(input[key])
				}`
		)
		.join(", ");
	return formatted.length <= MAX_TOOL_ARGUMENTS_LENGTH
		? formatted
		: `${formatted.slice(0, MAX_TOOL_ARGUMENTS_LENGTH)}…`;
};

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

const formatStaticToolSummary = (name: string, part: ToolPart): string => {
	const input = getToolInputRecord(part);
	const path =
		typeof input.path === "string" ? sanitizeDisplayText(input.path) : ".";
	if (name === "grep") {
		const pattern = sanitizeDisplayText(
			JSON.stringify(formatToolArgumentValue(input.pattern))
		);
		return `✱ Grep ${pattern} in ${path}`;
	}
	if (name === "shell") {
		const command = sanitizeDisplayText(
			typeof input.command === "string" ? input.command : ""
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
	const errorText = sanitizeDisplayText(formatUnknown(part.errorText));

	return `${formatUnknown(part.toolCallId) || `tool-${getToolName(part)}-${state}-${errorText}`}-${index}`;
};

const getContentPartKey = (
	part: Extract<MessagePart, { type: "reasoning" | "text" }>,
	index: number
): string => `${part.type}-${index}-${part.text}`;

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

const formatAgent = (agent: string) =>
	`${agent.charAt(0).toUpperCase()}${agent.slice(1)}`;

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

	if (metadata.agent) {
		items.push({
			color: getAgentColor(colors, metadata.agent),
			label: formatAgent(metadata.agent),
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

const SHELL_OUTPUT_ESC = String.fromCharCode(0x1b);
const SHELL_OUTPUT_BELL = String.fromCharCode(0x07);
const SHELL_OUTPUT_ANSI_CSI_REGEX = new RegExp(
	`${SHELL_OUTPUT_ESC}[0-9;]*[A-Za-z]`,
	"g"
);
const SHELL_OUTPUT_ANSI_OSC_REGEX = new RegExp(
	`${SHELL_OUTPUT_ESC}][^${SHELL_OUTPUT_BELL}]*${SHELL_OUTPUT_BELL}`,
	"g"
);
const SHELL_OUTPUT_TRAILING_NEWLINE_REGEX = /\n$/;

/** Printable output characters: tab, newline, and everything above C1. */
const isPrintableShellOutputCharacter = (code: number): boolean =>
	code === 0x09 ||
	code === 0x0a ||
	(code >= 0x20 && (code < 0x7f || code > 0x9f));

const stripShellOutputControlCharacters = (value: string): string =>
	Array.from(value, (character) =>
		isPrintableShellOutputCharacter(character.charCodeAt(0)) ? character : ""
	).join("");

/**
 * Sanitizes command output for display: ANSI escape sequences are stripped,
 * CRLF collapses to LF, and control characters are replaced, while newlines
 * and tabs survive so multi-line output renders faithfully. The trailing
 * newline is dropped because it terminates the last line rather than creating
 * an empty final line, so bounded previews count real lines only.
 */
const sanitizeShellOutputText = (
	value: string,
	maxChars = SHELL_OUTPUT_TAIL_BYTES
): string =>
	redactSensitiveDisplayText(
		stripShellOutputControlCharacters(
			value
				.replace(SHELL_OUTPUT_ANSI_CSI_REGEX, "")
				.replace(SHELL_OUTPUT_ANSI_OSC_REGEX, "")
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "")
				.replace(SHELL_OUTPUT_TRAILING_NEWLINE_REGEX, "")
		)
	).slice(0, maxChars);

const MAX_SHELL_PREVIEW_ROWS = 6;
const MAX_SHELL_HEADER_ROWS = 2;
const SHELL_BLOCK_PADDING_X = 2;
const SHELL_BLOCK_BORDER_WIDTH = 1;
const SHELL_BLOCK_BORDER_SIDES = 1;

/** Terminal columns for one character: tabs occupy one cell, wide characters two. */
const measureShellDisplayChar = (character: string): number =>
	character === "\t" ? 1 : globalThis.Bun.stringWidth(character);

/**
 * Wraps one logical line into rows that each fit the given content width,
 * using terminal-cell semantics so wide characters never overflow a row.
 */
const wrapShellLineToWidth = (line: string, contentWidth: number): string[] => {
	if (contentWidth <= 0) {
		return [""];
	}
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;
	for (const character of line) {
		const characterWidth = measureShellDisplayChar(character);
		if (rowWidth + characterWidth > contentWidth) {
			rows.push(row);
			row = character;
			rowWidth = characterWidth;
		} else {
			row += character;
			rowWidth += characterWidth;
		}
	}
	rows.push(row);
	return rows;
};

/** Cuts a line to the given cell width, never splitting a wide character. */
const truncateShellLineToWidth = (line: string, maxWidth: number): string => {
	if (maxWidth <= 0) {
		return "";
	}
	let result = "";
	let width = 0;
	for (const character of line) {
		const characterWidth = measureShellDisplayChar(character);
		if (width + characterWidth > maxWidth) {
			break;
		}
		result += character;
		width += characterWidth;
	}
	return result;
};

type ShellOutputPreview = {
	hasOverflow: boolean;
	hiddenLogicalLines: number;
	text: string;
};

/**
 * Bounds sanitized shell output to six visual rows measured against the
 * block's measured content width. Rows come from the beginning of the result,
 * and the returned text contains only those visible rows, so the collapsed
 * renderer never receives the complete result behind the bound.
 */
const computeShellOutputPreview = (
	text: string,
	contentWidth: number
): ShellOutputPreview => {
	if (contentWidth <= 0) {
		return { hasOverflow: false, hiddenLogicalLines: 0, text: "" };
	}
	const logicalLines = text.split("\n");
	const rows: string[] = [];
	let remainingRows = MAX_SHELL_PREVIEW_ROWS;
	for (const [index, line] of logicalLines.entries()) {
		if (remainingRows === 0) {
			return {
				hasOverflow: true,
				hiddenLogicalLines: logicalLines.length - index,
				text: rows.join("\n"),
			};
		}
		const wrappedRows = wrapShellLineToWidth(line, contentWidth);
		if (wrappedRows.length <= remainingRows) {
			rows.push(...wrappedRows);
			remainingRows -= wrappedRows.length;
			continue;
		}
		rows.push(...wrappedRows.slice(0, remainingRows));
		return {
			hasOverflow: true,
			hiddenLogicalLines: logicalLines.length - index - 1,
			text: rows.join("\n"),
		};
	}
	return { hasOverflow: false, hiddenLogicalLines: 0, text: rows.join("\n") };
};

/**
 * The hidden-content indicator: fully hidden logical lines are reported as
 * `… N more lines`, while overflow caused only by wrapping a long line is
 * reported as `… more output`.
 */
const resolveShellOutputIndicator = (
	preview: ShellOutputPreview
): string | null => {
	if (!preview.hasOverflow) {
		return null;
	}
	return preview.hiddenLogicalLines > 0
		? `… ${preview.hiddenLogicalLines} more lines`
		: "… more output";
};

/**
 * Bounds the command header to two visual rows. Overflowing headers end with
 * an ellipsis so a very long command can never dominate a collapsed block.
 */
const boundShellCommandHeader = (
	command: string,
	contentWidth: number
): string => {
	if (contentWidth <= 0) {
		return "";
	}
	const rows = wrapShellLineToWidth(`$ ${command}`, contentWidth);
	if (rows.length <= MAX_SHELL_HEADER_ROWS) {
		return rows.join("\n");
	}
	const kept = rows.slice(0, MAX_SHELL_HEADER_ROWS);
	const lastRow = kept[MAX_SHELL_HEADER_ROWS - 1] ?? "";
	kept[MAX_SHELL_HEADER_ROWS - 1] = `${truncateShellLineToWidth(
		lastRow,
		contentWidth - 1
	)}…`;
	return kept.join("\n");
};

function ToolMessagePart({ part }: { part: ToolPart }) {
	const { colors } = useTheme();
	const isSkillCall =
		part.type === "dynamic-tool" &&
		part.toolName === "skill" &&
		(part.state === "output-available" || part.state === "output-error");
	const isShellOutput =
		part.type === "tool-shell" && part.state === "output-available";

	let toolLine: ReactNode = <ToolCallLine colors={colors} part={part} />;
	if (isSkillCall) {
		toolLine = <SkillActivityRow part={part} />;
	} else if (isShellOutput) {
		// The shell block groups the command header itself, so the standalone
		// tool row is skipped for completed shell calls.
		toolLine = null;
	}

	return (
		<>
			{toolLine}
			{isShellOutput ? <ShellOutputBlock part={part} /> : null}
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
	const command = sanitizeDisplayText(
		formatUnknown(getToolInputRecord(part).command)
	);

	const sanitizedText = useMemo(
		() => sanitizeShellOutputText(rawText),
		[rawText]
	);
	const preview = useMemo(
		() => computeShellOutputPreview(sanitizedText, contentWidth),
		[sanitizedText, contentWidth]
	);
	const header = useMemo(
		() => boundShellCommandHeader(command, contentWidth),
		[command, contentWidth]
	);
	const indicator = resolveShellOutputIndicator(preview);
	const canExpand = preview.hasOverflow;

	// The measured content width drives preview wrapping and the header bound.
	// Reflowing on real size changes (terminal resize, sidebar toggle) keeps the
	// collapsed preview bounded while never touching the expansion state.
	const handleBlockResize = () => {
		const width = blockRef.current?.width ?? 0;
		if (width <= 0) {
			return;
		}
		const measured = Math.max(
			0,
			width -
				SHELL_BLOCK_PADDING_X * 2 -
				SHELL_BLOCK_BORDER_WIDTH * SHELL_BLOCK_BORDER_SIDES
		);
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
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box handles terminal mouse events; keyboard output navigation lands in a separate issue.
		<box
			border={["left"]}
			borderColor={colors.backgroundElement}
			customBorderChars={{
				...EmptyBorder,
				vertical: "┃",
			}}
			flexDirection="column"
			marginBottom={1}
			onMouseDown={() => {
				if (canExpand) {
					setExpanded((value) => !value);
				}
			}}
			onSizeChange={handleBlockResize}
			ref={blockRef}
			width="100%"
		>
			<box
				backgroundColor={colors.backgroundElement}
				flexDirection="column"
				gap={1}
				paddingX={SHELL_BLOCK_PADDING_X}
				paddingY={1}
				width="100%"
			>
				<text fg={colors.text} wrapMode="char">
					{header}
				</text>
				{markers.length > 0 ? (
					<text fg={hasFailed ? colors.error : colors.textMuted}>
						{markers}
					</text>
				) : null}
				<text fg={colors.text} wrapMode="char">
					{expanded ? sanitizedText : preview.text}
				</text>
				{expanded || indicator === null ? null : (
					<text fg={colors.textMuted}>{indicator}</text>
				)}
			</box>
		</box>
	);
}

function ToolCallLine({
	colors,
	part,
}: {
	colors: ReturnType<typeof useTheme>["colors"];
	part: ToolPart;
}) {
	const errorText = redactSensitiveDisplayText(
		sanitizeDisplayText(formatUnknown(part.errorText))
	);
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

const formatSkillHash = (hash: unknown): string => {
	const value = typeof hash === "string" ? hash : "";
	return value.length > 12 ? `${value.slice(0, 12)}…` : value;
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
	const name = sanitizeDisplayText(
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
			? sanitizeDisplayText(formatUnknown(output?.error ?? part.errorText))
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
								<box
									key={getContentPartKey(part, index)}
									paddingX={3}
									width="100%"
								>
									<text fg={colors.text}>{part.text}</text>
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
				<span fg={colors.primary}>{FOOTER_ICON}</span>
				{"  "}
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
