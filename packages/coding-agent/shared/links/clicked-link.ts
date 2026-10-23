import type { CliRenderer, MouseEvent } from "@opentui/core";

/**
 * Resolves the hyperlink under a plain left click. OpenTUI marks the release
 * that ends a selection gesture with `isDragging`, and a fresh "cell" selection
 * means the pointer never moved; a drag therefore selects text instead of
 * opening the link. Modified clicks stay with the terminal's native handling.
 */
export const clickedLink = (
	renderer: CliRenderer,
	event: MouseEvent
): string | undefined => {
	if (
		event.button !== 0 ||
		!event.isDragging ||
		event.modifiers.ctrl ||
		event.modifiers.alt ||
		event.modifiers.shift
	) {
		return;
	}
	const selection = renderer.getSelection();
	if (!selection?.isStart || selection.behavior !== "cell") {
		return;
	}
	return renderer.getLinkAt(event.x, event.y) ?? undefined;
};
