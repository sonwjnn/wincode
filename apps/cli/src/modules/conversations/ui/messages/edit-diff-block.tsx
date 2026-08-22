import { isAbsolute } from "node:path";
import { type BoxRenderable, pathToFiletype } from "@opentui/core";
import {
	type CodingAgentUIMessage,
	type EditDiff,
	isRenderableEditDiff,
} from "@wincode/ai";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { stripControlCharacters } from "@/shared/display-sanitize";
import { useToggleShortcut } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
import { ConversationBlock } from "./conversation-block";
import {
	getTreeSitterClientForTests,
	resolveSyntaxStyle,
} from "./syntax-style";

type EditToolPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "tool-edit" }
>;

type EditDiffBlockProps = {
	part: EditToolPart;
};

const DIFF_BREAKPOINT_COLUMNS = 120;
const DIFF_COLLAPSE_LINES = 30;
const DIFF_BLOCK_PADDING_X = 2;

const isSafeDiffCharacter = (code: number): boolean =>
	code === 0x09 ||
	code === 0x0a ||
	(code >= 0x20 && (code < 0x7f || code > 0x9f));

const sanitizeDiffPatch = (patch: string): string =>
	Array.from(patch, (character) =>
		isSafeDiffCharacter(character.charCodeAt(0)) ? character : " "
	).join("");

const formatEditPath = (filePath: string): string => {
	const sanitized = stripControlCharacters(filePath, 512);
	return isAbsolute(sanitized) ? sanitized : sanitized.replaceAll("\\", "/");
};

const getOutput = (part: EditToolPart): Record<string, unknown> =>
	typeof part.output === "object" &&
	part.output !== null &&
	!Array.isArray(part.output)
		? (part.output as Record<string, unknown>)
		: {};

const getEditPath = (
	part: EditToolPart,
	output: Record<string, unknown>
): string => {
	if (typeof output.path === "string") {
		return output.path;
	}
	if (typeof part.input?.path === "string") {
		return part.input.path;
	}
	return ".";
};

const patchLineCount = (patch: string): number =>
	patch.length === 0
		? 0
		: patch.split("\n").length - (patch.endsWith("\n") ? 1 : 0);
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

type PreviewHunk = {
	lines: string[];
	newStart: string;
	oldStart: string;
	suffix: string;
};
type GreenPreviewHunk = PreviewHunk & {
	otherLines: string[];
};

const countHunkLines = (lines: string[]) => {
	let oldCount = 0;
	let newCount = 0;
	for (const line of lines) {
		if (line.startsWith(" ") || line.startsWith("-")) {
			oldCount += 1;
		}
		if (line.startsWith(" ") || line.startsWith("+")) {
			newCount += 1;
		}
	}
	return { newCount, oldCount };
};

export const limitPatchLines = (patch: string, maxLines: number): string => {
	if (patchLineCount(patch) <= maxLines) {
		return patch;
	}

	const previewLines = patch.split("\n").slice(0, maxLines);
	const output: string[] = [];
	let currentHunk: PreviewHunk | undefined;
	const flushHunk = () => {
		if (!currentHunk || currentHunk.lines.length === 0) {
			return;
		}
		const { newCount, oldCount } = countHunkLines(currentHunk.lines);
		output.push(
			`@@ -${currentHunk.oldStart},${oldCount} +${currentHunk.newStart},${newCount} @@${currentHunk.suffix}`
		);
		output.push(...currentHunk.lines);
		currentHunk = undefined;
	};

	for (const line of previewLines) {
		const header = line.match(HUNK_HEADER_RE);
		if (header) {
			flushHunk();
			currentHunk = {
				lines: [],
				newStart: header[2] ?? "1",
				oldStart: header[1] ?? "1",
				suffix: header[3] ?? "",
			};
			continue;
		}
		if (currentHunk) {
			currentHunk.lines.push(line);
		} else {
			output.push(line);
		}
	}
	flushHunk();
	return `${output.join("\n")}\n`;
};
export const buildAddedPreviewPatch = (
	patch: string,
	maxLines: number
): string => {
	const output: string[] = [];
	let currentHunk: GreenPreviewHunk | undefined;
	let addedLineCount = 0;
	const flushHunk = () => {
		if (!currentHunk) {
			return;
		}
		const lines = [...currentHunk.lines, ...currentHunk.otherLines];
		if (lines.length === 0) {
			return;
		}
		const { newCount, oldCount } = countHunkLines(lines);
		output.push(
			`@@ -${currentHunk.oldStart},${oldCount} +${currentHunk.newStart},${newCount} @@${currentHunk.suffix}`
		);
		output.push(...lines);
		addedLineCount += currentHunk.lines.length;
		currentHunk = undefined;
	};

	for (const line of patch.split("\n")) {
		const header = line.match(HUNK_HEADER_RE);
		if (header) {
			flushHunk();
			currentHunk = {
				lines: [],
				newStart: header[2] ?? "1",
				oldStart: header[1] ?? "1",
				otherLines: [],
				suffix: header[3] ?? "",
			};
			continue;
		}
		if (currentHunk) {
			if (line.startsWith("+")) {
				currentHunk.lines.push(line);
			} else {
				currentHunk.otherLines.push(line);
			}
			continue;
		}
		output.push(line);
	}
	flushHunk();

	if (addedLineCount === 0) {
		return limitPatchLines(patch, maxLines);
	}
	return limitPatchLines(`${output.join("\n")}\n`, maxLines);
};

const isEditOutputWithDiff = (
	part: EditToolPart
): { path: string; editDiff?: EditDiff; invalid: boolean } | null => {
	if (part.state !== "output-available") {
		return null;
	}

	const output = getOutput(part);
	if (!("editDiff" in output)) {
		return null;
	}

	const path = getEditPath(part, output);
	if (output.editDiff === undefined) {
		return { invalid: true, path };
	}
	if (!isRenderableEditDiff(output.editDiff)) {
		return { invalid: true, path };
	}
	return { editDiff: output.editDiff, invalid: false, path };
};

const DiffHeader = ({
	colors,
	path,
	additions,
	deletions,
}: {
	colors: ThemeColors;
	path: string;
	additions: number;
	deletions: number;
}) => (
	<box flexDirection="row" gap={1} width="100%">
		<text fg={colors.text} wrapMode="char">
			{`← Edit ${path}`}
		</text>
		<text fg={colors.diffAdded}>{`+${additions}`}</text>
		<text fg={colors.diffRemoved}>{`−${deletions}`}</text>
	</box>
);
const DiffStatusPanel = ({
	children,
	colors,
}: {
	children: ReactNode;
	colors: ThemeColors;
}) => (
	<ConversationBlock colors={colors} paddingX={DIFF_BLOCK_PADDING_X}>
		{children}
	</ConversationBlock>
);

const EmptyPatchStatus = ({
	colors,
	editDiff,
	path,
}: {
	colors: ThemeColors;
	editDiff: EditDiff;
	path: string;
}) => {
	if (editDiff.additions === 0 && editDiff.deletions === 0) {
		return (
			<DiffStatusPanel colors={colors}>
				<text fg={colors.text}>{`← Edit ${path} · No content changes`}</text>
			</DiffStatusPanel>
		);
	}

	return (
		<DiffStatusPanel colors={colors}>
			<DiffHeader
				additions={editDiff.additions}
				colors={colors}
				deletions={editDiff.deletions}
				path={path}
			/>
			<text fg={colors.textMuted}>Diff preview omitted</text>
		</DiffStatusPanel>
	);
};

export function EditDiffBlock({ part }: EditDiffBlockProps) {
	const { colors } = useTheme();
	const blockRef = useRef<BoxRenderable>(null);
	const [blockWidth, setBlockWidth] = useState(0);
	const output = getOutput(part);
	const result = isEditOutputWithDiff(part);
	const path = formatEditPath(result?.path ?? getEditPath(part, output));
	const editDiff = result?.editDiff;
	const patch = useMemo(
		() => sanitizeDiffPatch(editDiff?.patch ?? ""),
		[editDiff?.patch]
	);
	const logicalLines = patchLineCount(patch);
	const shouldCollapse = logicalLines > DIFF_COLLAPSE_LINES;
	const [expanded, setExpanded] = useState(() => !shouldCollapse);
	const visiblePatch = expanded
		? patch
		: buildAddedPreviewPatch(patch, DIFF_COLLAPSE_LINES);
	const toggleExpanded = () => {
		setExpanded((value) => !value);
	};
	useToggleShortcut(
		"ctrl+o",
		toggleExpanded,
		logicalLines > DIFF_COLLAPSE_LINES
	);

	if (!result) {
		if (part.state === "input-available") {
			return (
				<DiffStatusPanel colors={colors}>
					<text fg={colors.text}>{`← Edit ${path}`}</text>
				</DiffStatusPanel>
			);
		}
		return null;
	}

	if (result.invalid || !editDiff) {
		return (
			<DiffStatusPanel colors={colors}>
				<text fg={colors.text}>{`← Edit ${path}`}</text>
				<text fg={colors.error}>Diff unavailable</text>
			</DiffStatusPanel>
		);
	}

	if (editDiff.patch.length === 0) {
		return <EmptyPatchStatus colors={colors} editDiff={editDiff} path={path} />;
	}

	const handleBlockResize = () => {
		const width = blockRef.current?.width ?? 0;
		if (width <= 0) {
			return;
		}
		queueMicrotask(() => {
			setBlockWidth((current) => (current === width ? current : width));
		});
	};
	const view = blockWidth > DIFF_BREAKPOINT_COLUMNS ? "split" : "unified";
	const syntaxStyle = resolveSyntaxStyle(colors);

	return (
		<ConversationBlock
			blockRef={blockRef}
			colors={colors}
			onSizeChange={handleBlockResize}
			paddingX={DIFF_BLOCK_PADDING_X}
		>
			<DiffHeader
				additions={editDiff.additions}
				colors={colors}
				deletions={editDiff.deletions}
				path={path}
			/>
			{editDiff.truncated ? (
				<text fg={colors.textMuted}>
					{editDiff.patch.length === 0
						? "Diff preview unavailable"
						: `… ${editDiff.omittedHunks} hunks omitted`}
				</text>
			) : null}
			<box width="100%">
				<diff
					addedBg={colors.diffAddedBg}
					addedLineNumberBg={colors.diffAddedLineNumberBg}
					addedSignColor={colors.diffHighlightAdded}
					contextBg={colors.diffContextBg}
					diff={visiblePatch}
					filetype={pathToFiletype(path)}
					lineNumberBg={colors.diffContextBg}
					lineNumberFg={colors.diffLineNumber}
					removedBg={colors.diffRemovedBg}
					removedLineNumberBg={colors.diffRemovedLineNumberBg}
					removedSignColor={colors.diffHighlightRemoved}
					showLineNumbers
					syntaxStyle={syntaxStyle}
					treeSitterClient={getTreeSitterClientForTests()}
					view={view}
					width="100%"
					wrapMode="word"
				/>
			</box>
			{logicalLines > DIFF_COLLAPSE_LINES ? (
				<text fg={colors.textMuted}>
					{expanded
						? "(Ctrl+O: Collapse)"
						: `… ${logicalLines - DIFF_COLLAPSE_LINES} more ${
								logicalLines - DIFF_COLLAPSE_LINES === 1 ? "line" : "lines"
							} (Ctrl+O: Expand)`}
				</text>
			) : null}
		</ConversationBlock>
	);
}
