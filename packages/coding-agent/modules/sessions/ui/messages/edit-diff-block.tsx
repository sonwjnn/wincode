import { isAbsolute } from "node:path";
import { type BoxRenderable, pathToFiletype } from "@opentui/core";
import type { AgentId } from "@wincode/agent-core";
import {
	isArray,
	isPlainObject,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import { type ReactNode, useMemo, useRef, useState } from "react";
import type { SessionMessage } from "@/modules/sessions/message";
import { type EditDiff, isRenderableEditDiff } from "@/modules/tools";
import { stripControlCharacters } from "@/shared/display-sanitize";
import { useToggleShortcut } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { Spinner } from "@/shared/ui/spinner";
import {
	getTreeSitterClientForTests,
	resolveSyntaxStyle,
} from "./syntax-style";

type EditToolPart = Extract<
	SessionMessage["parts"][number],
	{ type: "tool-edit" }
>;

type EditDiffBlockProps = {
	agent: AgentId;
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
type EditPartFields = {
	readonly editDiff?: unknown;
	readonly files?: unknown;
	readonly fullDiffArtifact?: unknown;
	readonly path?: unknown;
};

const readEditPartFields = (value: unknown): EditPartFields => {
	if (!isPlainObject(value)) {
		return {};
	}
	const path = Reflect.get(value, "path");
	const editDiff = Reflect.get(value, "editDiff");
	const files = Reflect.get(value, "files");
	const fullDiffArtifact = Reflect.get(value, "fullDiffArtifact");
	return {
		...omitUndefined({ editDiff, files, fullDiffArtifact, path }),
	};
};

const getOutput = (part: EditToolPart): EditPartFields =>
	readEditPartFields(part.output);
const getInput = (part: EditToolPart): EditPartFields =>
	readEditPartFields(part.input);

type MultiEditFile = {
	artifact: boolean;
	hunkCount: number;
	path: string;
};

const readMultiEditFiles = (output: EditPartFields): MultiEditFile[] | null => {
	if (!isArray(output.files)) {
		return null;
	}
	const files = output.files.map((file) => {
		if (!isPlainObject(file)) {
			return null;
		}
		const path = Reflect.get(file, "path");
		const hunkCount = Reflect.get(file, "hunkCount");
		return isString(path) && typeof hunkCount === "number"
			? {
					artifact: isPlainObject(Reflect.get(file, "fullDiffArtifact")),
					hunkCount,
					path,
				}
			: null;
	});
	return files.every((file) => file !== null)
		? (files as MultiEditFile[])
		: null;
};
const getEditPath = (part: EditToolPart, output: EditPartFields): string => {
	if (isString(output.path)) {
		return output.path;
	}
	const input = getInput(part);
	if (isString(input.path)) {
		return input.path;
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
): {
	artifact?: boolean;
	path: string;
	editDiff?: EditDiff;
	invalid: boolean;
} | null => {
	if (part.state !== "output-available") {
		return null;
	}

	const output = getOutput(part);
	const path = getEditPath(part, output);
	if (isUndefined(output.editDiff)) {
		return isPlainObject(output.fullDiffArtifact)
			? { artifact: true, invalid: false, path }
			: null;
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
		<text fg={colors.textMuted} wrapMode="char">
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
	<BorderedContentBlock colors={colors} paddingX={DIFF_BLOCK_PADDING_X}>
		{children}
	</BorderedContentBlock>
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
				<text
					fg={colors.textMuted}
				>{`← Edit ${path} · No content changes`}</text>
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

const isEditRunningState = (state: EditToolPart["state"]): boolean =>
	state === "input-available" || state === "input-streaming";

const EditRunningStatus = ({
	agent,
	path,
}: {
	agent: AgentId;
	path: string;
}) => {
	const { colors } = useTheme();
	return (
		<DiffStatusPanel colors={colors}>
			<box alignItems="center" flexDirection="row" gap={1} width="100%">
				<Spinner agent={agent} />
				<text fg={colors.textMuted}>{`Editing${path ? ` ${path}` : ""}`}</text>
			</box>
		</DiffStatusPanel>
	);
};
const MultiEditStatus = ({ files }: { files: readonly MultiEditFile[] }) => {
	const { colors } = useTheme();
	return (
		<DiffStatusPanel colors={colors}>
			<text fg={colors.textMuted}>{`← Edited ${files.length} files`}</text>
			{files.map((file) => (
				<box flexDirection="row" gap={1} key={file.path} width="100%">
					<text fg={colors.textMuted}>{`✓ ${formatEditPath(file.path)}`}</text>
					<text fg={colors.textMuted}>
						{file.artifact
							? `${file.hunkCount} hunks · full diff available`
							: `${file.hunkCount} hunks`}
					</text>
				</box>
			))}
		</DiffStatusPanel>
	);
};
const getMultiEditStatus = (
	part: EditToolPart,
	files: readonly MultiEditFile[] | null
): ReactNode | null => {
	if (part.state !== "output-available" || files === null) {
		return null;
	}
	return <MultiEditStatus files={files} />;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: output states intentionally share one compact diff/status renderer.
function EditDiffContent({ agent, part }: EditDiffBlockProps) {
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
		if (!isEditRunningState(part.state)) {
			return null;
		}
		const input = getInput(part);
		const runningPath = isString(input.path) ? formatEditPath(input.path) : "";
		return <EditRunningStatus agent={agent} path={runningPath} />;
	}

	if (result.artifact && !editDiff) {
		return (
			<DiffStatusPanel colors={colors}>
				<text fg={colors.textMuted}>{`← Edit ${path}`}</text>
				<text fg={colors.textMuted}>Full diff available as artifact</text>
			</DiffStatusPanel>
		);
	}
	if (result.invalid || !editDiff) {
		return (
			<DiffStatusPanel colors={colors}>
				<text fg={colors.textMuted}>{`← Edit ${path}`}</text>
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
		<BorderedContentBlock
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
		</BorderedContentBlock>
	);
}
export function EditDiffBlock({ agent, part }: EditDiffBlockProps) {
	const output = getOutput(part);
	const multiStatus = getMultiEditStatus(part, readMultiEditFiles(output));
	if (multiStatus !== null) {
		return multiStatus;
	}
	return <EditDiffContent agent={agent} part={part} />;
}
