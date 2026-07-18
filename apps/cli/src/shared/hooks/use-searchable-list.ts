import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

export function useSearchableList<T>(
	items: readonly T[],
	filterFn: (item: T, query: string) => boolean,
	initialSelectedIndex = 0,
	isSelectable: (item: T) => boolean = () => true
) {
	const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
	const [isScrollReady, setIsScrollReady] = useState(false);
	const [searchValue, setSearchValue] = useState("");
	const inputRef = useRef<InputRenderable>(null);
	const initialSelectedIndexRef = useRef(initialSelectedIndex);
	const selectedIndexRef = useRef(initialSelectedIndex);
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
	const selectableIndices = filtered.flatMap((item, index) =>
		isSelectable(item) ? [index] : []
	);

	const scrollSelectedItemIntoCenter = useCallback(
		(index: number) => {
			const scrollbox = scrollRef.current;
			if (!scrollbox) {
				return false;
			}

			const viewportHeight = scrollbox.viewport.height;
			if (viewportHeight <= 0) {
				return false;
			}

			const centerOffset = Math.floor(viewportHeight / 2);
			const maxScrollTop = Math.max(0, filtered.length - viewportHeight);
			const targetScrollTop = Math.min(
				maxScrollTop,
				Math.max(0, index - centerOffset)
			);

			scrollbox.scrollTo(targetScrollTop);
			return true;
		},
		[filtered.length]
	);

	useEffect(() => {
		selectedIndexRef.current = selectedIndex;
	}, [selectedIndex]);

	useEffect(() => {
		if (initialSelectedIndexRef.current === initialSelectedIndex) {
			return;
		}

		initialSelectedIndexRef.current = initialSelectedIndex;
		selectedIndexRef.current = initialSelectedIndex;
		setSelectedIndex(initialSelectedIndex);
	}, [initialSelectedIndex]);

	useLayoutEffect(() => {
		if (scrollSelectedItemIntoCenter(selectedIndex)) {
			setIsScrollReady(true);
		}
	}, [scrollSelectedItemIntoCenter, selectedIndex]);

	useEffect(() => {
		if (scrollSelectedItemIntoCenter(selectedIndex)) {
			setIsScrollReady(true);
			return;
		}

		const timeout = setTimeout(() => {
			scrollSelectedItemIntoCenter(selectedIndex);
			setIsScrollReady(true);
		}, 0);

		return () => clearTimeout(timeout);
	}, [scrollSelectedItemIntoCenter, selectedIndex]);

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
