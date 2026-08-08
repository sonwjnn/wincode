export function scrollCommandSelection(
	selectedIndex: number,
	visibleStartIndex: number,
	direction: "up" | "down",
	itemCount: number,
	maxVisibleItems: number
): { selectedIndex: number; visibleStartIndex: number } {
	if (itemCount === 0) {
		return { selectedIndex, visibleStartIndex };
	}
	const delta = direction === "down" ? 1 : -1;
	const nextIndex = Math.min(itemCount - 1, Math.max(0, selectedIndex + delta));
	const maxStart = Math.max(0, itemCount - maxVisibleItems);
	const nextStart = Math.min(maxStart, Math.max(0, visibleStartIndex + delta));
	const boundedStart = Math.min(nextStart, nextIndex);
	return { selectedIndex: nextIndex, visibleStartIndex: boundedStart };
}
