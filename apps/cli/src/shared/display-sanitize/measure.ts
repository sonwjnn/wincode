export const SHELL_BLOCK_PADDING_X = 2;
export const SHELL_BLOCK_BORDER_WIDTH = 1;
export const SHELL_BLOCK_BORDER_SIDES = 1;

/** Terminal columns for one character: tabs occupy one cell, wide characters two. */
export const measureCellWidth = (character: string): number =>
	character === "\t" ? 1 : globalThis.Bun.stringWidth(character);

/**
 * Wraps one logical line into rows that each fit the given content width,
 * using terminal-cell semantics so wide characters never overflow a row.
 */
export function wrapToWidth(line: string, contentWidth: number): string[] {
	if (contentWidth <= 0) {
		return [""];
	}
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;
	for (const character of line) {
		const characterWidth = measureCellWidth(character);
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
}

/** Cuts a line to the given cell width, never splitting a wide character. */
export function truncateToWidth(line: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	let result = "";
	let width = 0;
	for (const character of line) {
		const characterWidth = measureCellWidth(character);
		if (width + characterWidth > maxWidth) {
			break;
		}
		result += character;
		width += characterWidth;
	}
	return result;
}

/**
 * The content width of a shell block measured from its rendered box width:
 * the block's horizontal padding and border consume the remainder.
 */
export const computeContentWidth = (boxWidth: number): number =>
	Math.max(
		0,
		boxWidth -
			SHELL_BLOCK_PADDING_X * 2 -
			SHELL_BLOCK_BORDER_WIDTH * SHELL_BLOCK_BORDER_SIDES
	);
