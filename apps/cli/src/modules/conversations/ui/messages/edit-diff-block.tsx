import { extname, isAbsolute } from "node:path";
import { type BoxRenderable, RGBA } from "@opentui/core";
import {
	type CodingAgentUIMessage,
	type EditDiff,
	isRenderableEditDiff,
} from "@wincode/ai";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { EmptyBorder } from "@/shared/constants";
import { stripControlCharacters } from "@/shared/display-sanitize";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
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
	chatViewportHeight?: number;
};

const DIFF_BREAKPOINT_COLUMNS = 120;
const DIFF_COLLAPSE_LINES = 20;
const DIFF_COLLAPSE_VIEWPORT_RATIO = 0.4;
const DIFF_EXPANDED_VIEWPORT_RATIO = 0.6;
const DIFF_BLOCK_PADDING_X = 2;
const DIFF_BACKGROUND_ALPHA = 0.18;
const DIFF_LINE_NUMBER_ALPHA = 0.1;

const FILETYPE_BY_EXTENSION: Record<string, string> = {
	".bash": "bash",
	".css": "css",
	".go": "go",
	".html": "html",
	".js": "javascript",
	".jsx": "javascript",
	".json": "json",
	".md": "markdown",
	".py": "python",
	".rs": "rust",
	".sh": "bash",
	".toml": "toml",
	".ts": "typescript",
	".tsx": "typescript",
	".yaml": "yaml",
	".yml": "yaml",
};

const isSafeDiffCharacter = (code: number): boolean =>
	code === 0x09 ||
	code === 0x0a ||
	(code >= 0x20 && (code < 0x7f || code > 0x9f));

const sanitizeDiffPatch = (patch: string): string =>
	Array.from(patch, (character) =>
		isSafeDiffCharacter(character.charCodeAt(0)) ? character : " "
	).join("");

const blendColor = (
	background: string,
	foreground: string,
	alpha: number
): RGBA => {
	const base = RGBA.fromHex(background);
	const tint = RGBA.fromHex(foreground);
	return RGBA.fromValues(
		base.r * (1 - alpha) + tint.r * alpha,
		base.g * (1 - alpha) + tint.g * alpha,
		base.b * (1 - alpha) + tint.b * alpha
	);
};

const filetypeForPath = (filePath: string): string | undefined =>
	FILETYPE_BY_EXTENSION[extname(filePath).toLowerCase()];

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
	expanded,
	path,
	stats,
	onToggle,
}: {
	colors: ThemeColors;
	expanded: boolean;
	path: string;
	stats: string;
	onToggle: () => void;
}) => (
	// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI header owns terminal mouse interaction.
	<box flexDirection="row" gap={1} onMouseDown={onToggle} width="100%">
		<text fg={colors.text}>{expanded ? "▾" : "▸"}</text>
		<text fg={colors.text} wrapMode="char">
			{`← Edit ${path} ${stats}`}
		</text>
	</box>
);
const DiffStatusPanel = ({
	children,
	colors,
}: {
	children: ReactNode;
	colors: ThemeColors;
}) => (
	<box
		backgroundColor={colors.backgroundElement}
		border={["left"]}
		borderColor={colors.borderSubtle}
		customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
		flexDirection="column"
		marginBottom={1}
		paddingX={DIFF_BLOCK_PADDING_X}
		paddingY={1}
		width="100%"
	>
		{children}
	</box>
);

export function EditDiffBlock({
	chatViewportHeight = 0,
	part,
}: EditDiffBlockProps) {
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
	const shouldCollapse =
		logicalLines > DIFF_COLLAPSE_LINES ||
		(chatViewportHeight > 0 &&
			logicalLines > chatViewportHeight * DIFF_COLLAPSE_VIEWPORT_RATIO);
	const [expanded, setExpanded] = useState(() => !shouldCollapse);
	const [hasInteracted, setHasInteracted] = useState(false);

	useEffect(() => {
		if (!hasInteracted && chatViewportHeight > 0) {
			setExpanded(!shouldCollapse);
		}
	}, [chatViewportHeight, hasInteracted, shouldCollapse]);

	if (!result) {
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
		return (
			<DiffStatusPanel colors={colors}>
				<text fg={colors.text}>{`← Edit ${path} · No content changes`}</text>
			</DiffStatusPanel>
		);
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
	const toggleExpanded = () => {
		setHasInteracted(true);
		setExpanded((value) => !value);
	};
	const view = blockWidth > DIFF_BREAKPOINT_COLUMNS ? "split" : "unified";
	const maxHeight =
		chatViewportHeight > 0
			? Math.max(
					3,
					Math.floor(chatViewportHeight * DIFF_EXPANDED_VIEWPORT_RATIO)
				)
			: undefined;
	const stats = `+${editDiff.additions} −${editDiff.deletions}`;
	const syntaxStyle = resolveSyntaxStyle(colors);
	const addedBg = blendColor(
		colors.backgroundElement,
		colors.success,
		DIFF_BACKGROUND_ALPHA
	);
	const removedBg = blendColor(
		colors.backgroundElement,
		colors.error,
		DIFF_BACKGROUND_ALPHA
	);
	const addedLineNumberBg = blendColor(
		colors.backgroundElement,
		colors.success,
		DIFF_LINE_NUMBER_ALPHA
	);
	const removedLineNumberBg = blendColor(
		colors.backgroundElement,
		colors.error,
		DIFF_LINE_NUMBER_ALPHA
	);

	return (
		<box
			backgroundColor={colors.backgroundElement}
			border={["left"]}
			borderColor={colors.borderSubtle}
			customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
			flexDirection="column"
			marginBottom={1}
			onSizeChange={handleBlockResize}
			paddingX={DIFF_BLOCK_PADDING_X}
			paddingY={1}
			ref={blockRef}
			width="100%"
		>
			<DiffHeader
				colors={colors}
				expanded={expanded}
				onToggle={toggleExpanded}
				path={path}
				stats={stats}
			/>
			{editDiff.truncated ? (
				<text fg={colors.textMuted}>
					{editDiff.patch.length === 0
						? "Diff preview unavailable"
						: `… ${editDiff.omittedHunks} hunks omitted`}
				</text>
			) : null}
			{expanded ? (
				<scrollbox
					height={maxHeight}
					verticalScrollbarOptions={{ visible: true }}
					width="100%"
				>
					<diff
						addedBg={addedBg}
						addedContentBg={addedBg}
						addedLineNumberBg={addedLineNumberBg}
						addedSignColor={colors.success}
						contextBg={colors.backgroundElement}
						contextContentBg={colors.backgroundElement}
						diff={patch}
						filetype={filetypeForPath(path)}
						lineNumberBg={colors.backgroundElement}
						lineNumberFg={colors.textMuted}
						removedBg={removedBg}
						removedContentBg={removedBg}
						removedLineNumberBg={removedLineNumberBg}
						removedSignColor={colors.error}
						showLineNumbers
						syncScroll={view === "split"}
						syntaxStyle={syntaxStyle}
						treeSitterClient={getTreeSitterClientForTests()}
						view={view}
						width="100%"
						wrapMode="word"
					/>
				</scrollbox>
			) : null}
		</box>
	);
}
