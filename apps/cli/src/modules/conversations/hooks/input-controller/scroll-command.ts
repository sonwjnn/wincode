export function scrollCommandViewport(
	visibleStartIndex: number,
	direction: "up" | "down",
	itemCount: number,
	maxVisibleItems: number
): number {
	if (itemCount === 0) {
		return visibleStartIndex;
	}
	const delta = direction === "down" ? 1 : -1;
	const maxStart = Math.max(0, itemCount - maxVisibleItems);
	return Math.min(maxStart, Math.max(0, visibleStartIndex + delta));
}
