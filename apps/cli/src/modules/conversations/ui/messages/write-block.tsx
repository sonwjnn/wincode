import { isAbsolute } from "node:path";
import { pathToFiletype } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useMemo, useState } from "react";
import { stripControlCharacters } from "@/shared/display-sanitize";
import { useToggleShortcut } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { ConversationBlock } from "./conversation-block";
import {
	getTreeSitterClientForTests,
	resolveSyntaxStyle,
} from "./syntax-style";

type WriteToolPart = Extract<
	CodingAgentUIMessage["parts"][number],
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
		Array.isArray(part.input) ||
		typeof part.input.content !== "string" ||
		typeof part.input.path !== "string" ||
		part.input.path.length === 0
	) {
		return null;
	}

	return { content: part.input.content, path: part.input.path };
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

const getWriteError = (part: WriteToolPart): string => {
	const error = stripControlCharacters(
		typeof part.errorText === "string" ? part.errorText : "",
		MAX_ERROR_LENGTH
	);
	return error || "Write failed";
};

export function isRenderableWritePart(part: WriteToolPart): boolean {
	return (
		(part.state === "input-available" ||
			part.state === "output-available" ||
			part.state === "output-error") &&
		getWriteInput(part) !== null
	);
}

export function WriteBlock({ part }: { part: WriteToolPart }) {
	const { colors } = useTheme();
	const input = getWriteInput(part);
	const content = input?.content ?? "";
	const path = formatWritePath(input?.path ?? ".");
	const displayData = useMemo(() => getWriteDisplayData(content), [content]);
	const lineCount = displayData.lineCount;
	const canExpand = lineCount > WRITE_COLLAPSE_LINES;
	const [expanded, setExpanded] = useState(false);
	const syntaxStyle = useMemo(() => resolveSyntaxStyle(colors), [colors]);
	const visibleContent = expanded
		? sanitizeWriteContent(content)
		: displayData.preview;
	const remainingLines = lineCount - WRITE_COLLAPSE_LINES;
	const isFailed = part.state === "output-error";

	useToggleShortcut("ctrl+o", () => setExpanded((value) => !value), canExpand);

	if (!(input && isRenderableWritePart(part))) {
		return null;
	}

	const status = isFailed ? " · Failed" : "";
	const footer = expanded
		? "(Ctrl+O: Collapse)"
		: `… ${remainingLines} more ${remainingLines === 1 ? "line" : "lines"} (Ctrl+O: Expand)`;

	return (
		<ConversationBlock colors={colors} paddingX={2}>
			<text fg={colors.text} wrapMode="char">
				{`Write ${path} · ${formatLineCount(lineCount)}${status}`}
			</text>
			{isFailed ? <text fg={colors.error}>{getWriteError(part)}</text> : null}
			{lineCount === 0 ? (
				<text fg={colors.textMuted}>Empty file</text>
			) : (
				<code
					content={visibleContent}
					filetype={pathToFiletype(path)}
					syntaxStyle={syntaxStyle}
					treeSitterClient={getTreeSitterClientForTests()}
					width="100%"
					wrapMode="none"
				/>
			)}
			{canExpand ? <text fg={colors.textMuted}>{footer}</text> : null}
		</ConversationBlock>
	);
}
