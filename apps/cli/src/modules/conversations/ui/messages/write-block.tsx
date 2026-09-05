import { isAbsolute } from "node:path";
import { pathToFiletype } from "@opentui/core";
import type { AgentId } from "@wincode/agent-core";
import { useMemo, useState } from "react";
import type { ConversationMessage } from "@/modules/conversations/message";
import { stripControlCharacters } from "@/shared/display-sanitize";
import { useToggleShortcut } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { Spinner } from "@/shared/ui/spinner";
import {
	getTreeSitterClientForTests,
	resolveSyntaxStyle,
} from "./syntax-style";

type WriteToolPart = Extract<
	ConversationMessage["parts"][number],
	{ type: "tool-write" }
>;

type WriteInput = {
	content: string;
	path: string;
};

const WRITE_COLLAPSE_LINES = 10;
const MAX_ERROR_LENGTH = 512;

const isSafeWriteCharacter = (code: number): boolean =>
	code === 0x09 ||
	code === 0x0a ||
	(code >= 0x20 && (code < 0x7f || code > 0x9f));

const sanitizeWriteContent = (content: string): string => {
	const sanitized: string[] = [];
	for (const character of content.replaceAll("\r\n", "\n")) {
		sanitized.push(
			isSafeWriteCharacter(character.charCodeAt(0)) ? character : " "
		);
	}
	return sanitized.join("");
};

const getWriteInput = (part: WriteToolPart): WriteInput | null => {
	if (
		typeof part.input !== "object" ||
		part.input === null ||
		Array.isArray(part.input)
	) {
		return null;
	}
	const input = part.input as Record<string, unknown>;
	if (
		typeof input.content !== "string" ||
		typeof input.path !== "string" ||
		input.path.length === 0
	) {
		return null;
	}
	return { content: input.content, path: input.path };
};

const formatWritePath = (filePath: string): string => {
	const sanitized = stripControlCharacters(filePath, MAX_ERROR_LENGTH);
	return isAbsolute(sanitized) ? sanitized : sanitized.replaceAll("\\", "/");
};

type WriteDisplayData = {
	lineCount: number;
	preview: string;
};

const getWriteDisplayData = (content: string): WriteDisplayData => {
	if (content.length === 0) {
		return { lineCount: 0, preview: "" };
	}

	const previewLines: string[] = [];
	let currentPreviewLine = "";
	let lineCount = 0;
	let lastWasNewline = false;
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index];
		let normalizedCharacter: string;
		if (character === "\r" && content[index + 1] === "\n") {
			index += 1;
			normalizedCharacter = "\n";
		} else if (character === "\n") {
			normalizedCharacter = "\n";
		} else {
			normalizedCharacter = isSafeWriteCharacter(character?.charCodeAt(0) ?? 0)
				? (character ?? " ")
				: " ";
		}

		if (normalizedCharacter === "\n") {
			lineCount += 1;
			lastWasNewline = true;
			if (previewLines.length < WRITE_COLLAPSE_LINES) {
				previewLines.push(currentPreviewLine);
				currentPreviewLine = "";
			}
			continue;
		}

		lastWasNewline = false;
		if (previewLines.length < WRITE_COLLAPSE_LINES) {
			currentPreviewLine += normalizedCharacter;
		}
	}

	if (!lastWasNewline) {
		lineCount += 1;
		if (previewLines.length < WRITE_COLLAPSE_LINES) {
			previewLines.push(currentPreviewLine);
		}
	}

	return { lineCount, preview: previewLines.join("\n") };
};

export const countWriteLines = (content: string): number =>
	getWriteDisplayData(content).lineCount;

export const buildWritePreview = (content: string): string =>
	getWriteDisplayData(content).preview;

const formatLineCount = (lineCount: number): string =>
	`${lineCount} ${lineCount === 1 ? "line" : "lines"}`;

/**
 * Renders write content as an all-added unified diff so the block shares the
 * diff view's line-number gutter, syntax highlighting, and readable contrast.
 */
export const buildWriteDiffPatch = (
	filePath: string,
	content: string
): string => {
	const lines = content.split("\n");
	return [
		`Index: ${filePath}`,
		"===================================================================",
		"--- /dev/null",
		`+++ ${filePath}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
	].join("\n");
};

export function isRenderableWritePart(part: WriteToolPart): boolean {
	return (
		(part.state === "input-available" ||
			part.state === "output-available" ||
			part.state === "output-error") &&
		getWriteInput(part) !== null
	);
}

const WriteRunningStatus = ({
	agent,
	path,
}: {
	agent: AgentId;
	path: string;
}) => {
	const { colors } = useTheme();
	return (
		<box alignItems="center" flexDirection="row" gap={1} width="100%">
			<Spinner agent={agent} />
			<text fg={colors.textMuted}>{`Writing${path ? ` ${path}` : ""}`}</text>
		</box>
	);
};

const WritePreview = ({
	content,
	isRunning,
	lineCount,
	path,
	visibleContent,
}: {
	content: string;
	isRunning: boolean;
	lineCount: number;
	path: string;
	visibleContent: string;
}) => {
	const { colors } = useTheme();
	const syntaxStyle = useMemo(() => resolveSyntaxStyle(colors), [colors]);

	if (isRunning && content.length === 0) {
		return null;
	}
	if (lineCount === 0) {
		return <text fg={colors.textMuted}>Empty file</text>;
	}
	return (
		<diff
			addedBg={colors.diffContextBg}
			addedContentBg={colors.diffContextBg}
			addedLineNumberBg={colors.diffContextBg}
			contextBg={colors.diffContextBg}
			diff={buildWriteDiffPatch(path, visibleContent)}
			filetype={pathToFiletype(path)}
			lineNumberBg={colors.diffContextBg}
			lineNumberFg={colors.diffLineNumber}
			removedBg={colors.diffRemovedBg}
			removedLineNumberBg={colors.diffRemovedLineNumberBg}
			removedSignColor={colors.diffHighlightRemoved}
			showLineNumbers
			syntaxStyle={syntaxStyle}
			treeSitterClient={getTreeSitterClientForTests()}
			view="unified"
			width="100%"
			wrapMode="word"
		/>
	);
};

export function WriteBlock({
	agent,
	part,
}: {
	agent: AgentId;
	part: WriteToolPart;
}) {
	const { colors } = useTheme();
	const rawInput =
		typeof part.input === "object" &&
		part.input !== null &&
		!Array.isArray(part.input)
			? (part.input as Record<string, unknown>)
			: {};
	const content = typeof rawInput.content === "string" ? rawInput.content : "";
	const path = formatWritePath(
		typeof rawInput.path === "string" ? rawInput.path : ""
	);
	const displayData = useMemo(() => getWriteDisplayData(content), [content]);
	const lineCount = displayData.lineCount;
	const isFailed = part.state === "output-error";
	const canExpand = lineCount > WRITE_COLLAPSE_LINES && !isFailed;
	const [expanded, setExpanded] = useState(false);
	const visibleContent = expanded
		? sanitizeWriteContent(content)
		: displayData.preview;
	const remainingLines = lineCount - WRITE_COLLAPSE_LINES;
	const isRunning =
		part.state === "input-streaming" || part.state === "input-available";

	useToggleShortcut("ctrl+o", () => setExpanded((value) => !value), canExpand);

	if (!(isRunning || isRenderableWritePart(part))) {
		return null;
	}

	const footer = expanded
		? "(Ctrl+O: Collapse)"
		: `… ${remainingLines} more ${remainingLines === 1 ? "line" : "lines"} (Ctrl+O: Expand)`;

	return (
		<BorderedContentBlock colors={colors} paddingX={2}>
			{isRunning ? (
				<WriteRunningStatus agent={agent} path={path} />
			) : (
				<text fg={isFailed ? colors.error : colors.textMuted} wrapMode="char">
					{`→ Write ${path} · ${formatLineCount(lineCount)}`}
				</text>
			)}
			{isFailed ? null : (
				<WritePreview
					content={content}
					isRunning={isRunning}
					lineCount={lineCount}
					path={path}
					visibleContent={visibleContent}
				/>
			)}
			{canExpand ? <text fg={colors.textMuted}>{footer}</text> : null}
		</BorderedContentBlock>
	);
}
