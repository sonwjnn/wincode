import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";

export function useSearchableList<T>(
	items: readonly T[],
	filterFn: (item: T, query: string) => boolean
) {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [searchValue, setSearchValue] = useState("");
	const inputRef = useRef<InputRenderable>(null);
	const selectedIndexRef = useRef(0);
	const scrollRef = useRef<ScrollBoxRenderable>(null);

	const handleContentChange = useCallback(() => {
		const text = inputRef.current?.value ?? "";
		setSearchValue(text);
		selectedIndexRef.current = 0;
		setSelectedIndex(0);

		const scrollbox = scrollRef.current;
		if (scrollbox) {
			scrollbox.scrollTo(0);
		}
	}, []);

	const filtered = searchValue
		? items.filter((item) => filterFn(item, searchValue))
		: items.slice();

	useEffect(() => {
		selectedIndexRef.current = selectedIndex;
	}, [selectedIndex]);

	useEffect(() => {
		if (selectedIndex < filtered.length || filtered.length === 0) {
			return;
		}
		const newIndex = filtered.length - 1;
		selectedIndexRef.current = newIndex;
		setSelectedIndex(newIndex);
	}, [filtered.length, selectedIndex]);

	const moveUp = useCallback(
		(onMove?: () => void) => {
			if (filtered.length === 0) {
				return;
			}
			setSelectedIndex((i) => {
				const newIndex = Math.max(0, i - 1);
				selectedIndexRef.current = newIndex;
				const sb = scrollRef.current;
				if (sb && newIndex < sb.scrollTop) {
					sb.scrollTo(newIndex);
				}
				if (onMove) {
					onMove();
				}
				return newIndex;
			});
		},
		[filtered.length]
	);

	const moveDown = useCallback(
		(onMove?: () => void) => {
			if (filtered.length === 0) {
				return;
			}
			setSelectedIndex((i) => {
				const newIndex = Math.min(filtered.length - 1, i + 1);
				selectedIndexRef.current = newIndex;
				const sb = scrollRef.current;
				if (sb) {
					const viewportHeight = sb.viewport.height;
					const visibleEnd = sb.scrollTop + viewportHeight - 1;
					if (newIndex > visibleEnd) {
						sb.scrollTo(newIndex - viewportHeight + 1);
					}
				}
				if (onMove) {
					onMove();
				}
				return newIndex;
			});
		},
		[filtered.length]
	);

	const handleEnter = useCallback(
		(onSelect: (item: T) => void) => {
			const item = filtered[selectedIndexRef.current];
			if (item) {
				onSelect(item);
			}
		},
		[filtered]
	);

	return {
		filtered,
		searchValue,
		selectedIndex,
		selectedIndexRef,
		setSelectedIndex,
		inputRef,
		scrollRef,
		handleContentChange,
		moveUp,
		moveDown,
		handleEnter,
	};
}
