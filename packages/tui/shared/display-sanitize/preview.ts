import { truncateToWidth, wrapToWidth } from "./measure";

export const MAX_SHELL_PREVIEW_ROWS = 6;
export const MAX_SHELL_HEADER_ROWS = 2;

export type ShellOutputPreview = {
	hasOverflow: boolean;
	hiddenLogicalLines: number;
	text: string;
};

/**
 * Bounds sanitized shell output to six visual rows measured against the
 * block's content width. Rows come from the beginning of the result, and the
 * returned text contains only those visible rows, so the collapsed renderer
 * never receives the complete result behind the bound.
 */
export function boundPreview(
	text: string,
	contentWidth: number
): ShellOutputPreview {
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
		const wrappedRows = wrapToWidth(line, contentWidth);
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
}

/**
 * The hidden-content indicator: fully hidden logical lines are reported as
 * `… N more lines`, while overflow caused only by wrapping a long line is
 * reported as `… more output`.
 */
export const resolveOverflowIndicator = (
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
export function boundCommandHeader(
	command: string,
	contentWidth: number
): string {
	if (contentWidth <= 0) {
		return "";
	}
	const rows = wrapToWidth(`$ ${command}`, contentWidth);
	if (rows.length <= MAX_SHELL_HEADER_ROWS) {
		return rows.join("\n");
	}
	const kept = rows.slice(0, MAX_SHELL_HEADER_ROWS);
	const lastRow = kept[MAX_SHELL_HEADER_ROWS - 1] ?? "";
	kept[MAX_SHELL_HEADER_ROWS - 1] = `${truncateToWidth(
		lastRow,
		contentWidth - 1
	)}…`;
	return kept.join("\n");
}
