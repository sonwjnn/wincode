import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useLatest } from "./use-latest";

function defaultItemHeight<T>(
	_item: T,
	_index: number,
	_items: readonly T[]
): number {
	return 1;
}

export function useSearchableList<T>(
	items: readonly T[],
	filterFn: (item: T, query: string) => boolean,
	initialSelectedIndex = 0,
	isSelectable: (item: T) => boolean = () => true,
	getItemHeight: (
		item: T,
		index: number,
		items: readonly T[]
	) => number = defaultItemHeight
) {
	const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
	const [isScrollReady, setIsScrollReady] = useState(false);
	const [searchValue, setSearchValue] = useState("");
	const inputRef = useRef<InputRenderable>(null);
	const initialSelectedIndexRef = useRef(initialSelectedIndex);
	const selectedIndexRef = useLatest(selectedIndex);
	const scrollRef = useRef<ScrollBoxRenderable>(null);

	const handleContentChange = useCallback(() => {
		const text = inputRef.current?.value ?? "";
		setSearchValue(text);

		const nextItems = text
			? items.filter((item) => filterFn(item, text))
			: items;
		const initialItem = nextItems[initialSelectedIndex];
		const nextSelectedIndex =
			text.length === 0 && initialItem && isSelectable(initialItem)
				? initialSelectedIndex
				: nextItems.findIndex(isSelectable);
		const resolvedIndex = Math.max(0, nextSelectedIndex);

		selectedIndexRef.current = resolvedIndex;
		setSelectedIndex(resolvedIndex);
	}, [filterFn, initialSelectedIndex, isSelectable, items]);

	const filtered = searchValue
		? items.filter((item) => filterFn(item, searchValue))
		: items.slice();

	let contentHeight = 0;
	let selectedItemOffset = 0;
	for (let index = 0; index < filtered.length; index += 1) {
		const item = filtered[index];
		if (item === undefined) {
			continue;
		}
		const itemHeight = getItemHeight(item, index, filtered);
		contentHeight += itemHeight;
		if (index < selectedIndex) {
			selectedItemOffset += itemHeight;
		}
	}

	const selectableIndices = filtered.flatMap((item, index) =>
		isSelectable(item) ? [index] : []
	);

	const scrollSelectedItemIntoCenter = useCallback(() => {
		const scrollbox = scrollRef.current;
		if (!scrollbox) {
			return false;
		}

		const viewportHeight = scrollbox.viewport.height;
		if (viewportHeight <= 0) {
			return false;
		}

		const centerOffset = Math.floor(viewportHeight / 2);
		const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
		const targetScrollTop = Math.min(
			maxScrollTop,
			Math.max(0, selectedItemOffset - centerOffset)
		);

		scrollbox.scrollTo(targetScrollTop);
		return true;
	}, [contentHeight, selectedItemOffset]);

	useEffect(() => {
		if (initialSelectedIndexRef.current === initialSelectedIndex) {
			return;
		}

		initialSelectedIndexRef.current = initialSelectedIndex;
		selectedIndexRef.current = initialSelectedIndex;
		setSelectedIndex(initialSelectedIndex);
	}, [initialSelectedIndex]);

	useLayoutEffect(() => {
		if (scrollSelectedItemIntoCenter()) {
			setIsScrollReady(true);
		}
	}, [scrollSelectedItemIntoCenter]);

	useEffect(() => {
		if (scrollSelectedItemIntoCenter()) {
			setIsScrollReady(true);
			return;
		}

		const timeout = setTimeout(() => {
			scrollSelectedItemIntoCenter();
			setIsScrollReady(true);
		}, 0);

		return () => clearTimeout(timeout);
	}, [scrollSelectedItemIntoCenter]);

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
			if (selectableIndices.length === 0) {
				return;
			}
			setSelectedIndex((i) => {
				const current = selectableIndices.indexOf(i);
				const previousPosition =
					current <= 0 ? selectableIndices.length - 1 : current - 1;
				const newIndex = selectableIndices[previousPosition] ?? i;
				selectedIndexRef.current = newIndex;
				if (onMove) {
					onMove();
				}
				return newIndex;
			});
		},
		[selectableIndices]
	);

	const moveDown = useCallback(
		(onMove?: () => void) => {
			if (selectableIndices.length === 0) {
				return;
			}
			setSelectedIndex((i) => {
				const current = selectableIndices.indexOf(i);
				const nextPosition =
					current === -1 || current === selectableIndices.length - 1
						? 0
						: current + 1;
				const newIndex = selectableIndices[nextPosition] ?? i;
				selectedIndexRef.current = newIndex;
				if (onMove) {
					onMove();
				}
				return newIndex;
			});
		},
		[selectableIndices]
	);

	const handleEnter = useCallback(
		(onSelect: (item: T) => void) => {
			const item = filtered[selectedIndexRef.current];
			if (item && isSelectable(item)) {
				onSelect(item);
			}
		},
		[filtered, isSelectable]
	);

	return {
		contentHeight,
		filtered,
		isScrollReady,
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
