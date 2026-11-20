import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTerminalDimensions } from "./react-hooks";

const defaultSelectable = (): boolean => true;
const defaultActive = (): boolean => false;

function defaultItemHeight<T>(
	_item: T,
	_index: number,
	_items: readonly T[]
): number {
	return 1;
}

function getInitialIndex<T>(
	items: readonly T[],
	isItemActive: (item: T) => boolean,
	isItemSelectable: (item: T) => boolean,
	initialSelectedIndex: number | undefined
): number {
	if (initialSelectedIndex !== undefined) {
		const boundedIndex = Math.max(
			0,
			Math.min(initialSelectedIndex, Math.max(0, items.length - 1))
		);
		const item = items[boundedIndex];
		if (item !== undefined && isItemSelectable(item)) {
			return boundedIndex;
		}
	}
	const activeIndex = items.findIndex(
		(item) => isItemActive(item) && isItemSelectable(item)
	);
	if (activeIndex >= 0) {
		return activeIndex;
	}
	return Math.max(0, items.findIndex(isItemSelectable));
}

function getValidSelectedIndex<T>(
	items: readonly T[],
	selectedIndex: number,
	isItemActive: (item: T) => boolean,
	isItemSelectable: (item: T) => boolean,
	initialSelectedIndex: number | undefined
): number {
	if (items.length === 0) {
		return 0;
	}
	const boundedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
	const boundedItem = items[boundedIndex];
	if (boundedItem !== undefined && isItemSelectable(boundedItem)) {
		return boundedIndex;
	}
	return getInitialIndex(
		items,
		isItemActive,
		isItemSelectable,
		initialSelectedIndex
	);
}

export type SearchableListOptions<T> = Readonly<{
	filterFn: (item: T, query: string) => boolean;
	getItemHeight?: (item: T, index: number, items: readonly T[]) => number;
	initialSelectedIndex?: number;
	isItemActive?: (item: T) => boolean;
	isItemSelectable?: (item: T) => boolean;
	items: readonly T[];
}>;

export function useSearchableList<T>({
	filterFn,
	getItemHeight = defaultItemHeight,
	initialSelectedIndex,
	isItemActive = defaultActive,
	isItemSelectable = defaultSelectable,
	items,
}: SearchableListOptions<T>) {
	const { height, width } = useTerminalDimensions();
	const initialIndex = getInitialIndex(
		items,
		isItemActive,
		isItemSelectable,
		initialSelectedIndex
	);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);
	const [isScrollReady, setIsScrollReady] = useState(false);
	const inputRef = useRef<InputRenderable | null>(null);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const selectedIndexRef = useRef(selectedIndex);
	const initialIndexRef = useRef(initialIndex);
	selectedIndexRef.current = selectedIndex;

	const filterItems = useCallback(
		(searchQuery: string) =>
			searchQuery.length === 0
				? items
				: items.filter((item) => filterFn(item, searchQuery)),
		[filterFn, items]
	);
	const filteredItems = filterItems(query);
	let contentHeight = 0;
	let selectedItemOffset = 0;
	for (let index = 0; index < filteredItems.length; index += 1) {
		const item = filteredItems[index];
		if (item === undefined) {
			continue;
		}
		const itemHeight = getItemHeight(item, index, filteredItems);
		contentHeight += itemHeight;
		if (index < selectedIndex) {
			selectedItemOffset += itemHeight;
		}
	}
	const selectableIndices = filteredItems.flatMap((item, index) =>
		isItemSelectable(item) ? [index] : []
	);

	const handleContentChange = useCallback(() => {
		const nextQuery = inputRef.current?.value ?? "";
		setQuery(nextQuery);
		const nextItems = filterItems(nextQuery);
		const nextSelectedIndex =
			nextQuery.length === 0
				? getInitialIndex(
						items,
						isItemActive,
						isItemSelectable,
						initialSelectedIndex
					)
				: Math.max(0, nextItems.findIndex(isItemSelectable));
		selectedIndexRef.current = nextSelectedIndex;
		setSelectedIndex(nextSelectedIndex);
	}, [
		filterItems,
		initialSelectedIndex,
		isItemActive,
		isItemSelectable,
		items,
	]);

	useEffect(() => {
		if (initialIndexRef.current === initialIndex) {
			return;
		}
		initialIndexRef.current = initialIndex;
		selectedIndexRef.current = initialIndex;
		setSelectedIndex(initialIndex);
	}, [initialIndex]);

	useLayoutEffect(() => {
		const validIndex = getValidSelectedIndex(
			filteredItems,
			selectedIndex,
			isItemActive,
			isItemSelectable,
			initialSelectedIndex
		);
		if (validIndex !== selectedIndex) {
			selectedIndexRef.current = validIndex;
			setSelectedIndex(validIndex);
		}
	}, [
		filteredItems,
		initialSelectedIndex,
		isItemActive,
		isItemSelectable,
		selectedIndex,
	]);

	const scrollSelectedItemIntoCenter = useCallback(() => {
		const scrollbox = scrollRef.current;
		if (!scrollbox) {
			return false;
		}
		const viewportHeight = Math.min(scrollbox.viewport.height, height);
		if (viewportHeight <= 0) {
			return false;
		}
		const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
		const targetScrollTop = Math.min(
			maxScrollTop,
			Math.max(0, selectedItemOffset - Math.floor(viewportHeight / 2))
		);
		scrollbox.scrollTo(targetScrollTop);
		return true;
	}, [contentHeight, height, selectedItemOffset]);

	useLayoutEffect(() => {
		if (scrollSelectedItemIntoCenter()) {
			setIsScrollReady(true);
		}
	}, [scrollSelectedItemIntoCenter]);

	useEffect(() => {
		if (width <= 0) {
			return;
		}
		// OpenTUI updates the scroll viewport after React commits terminal dimensions.
		const timeout = setTimeout(() => {
			scrollSelectedItemIntoCenter();
			setIsScrollReady(true);
		}, 0);
		return () => clearTimeout(timeout);
	}, [scrollSelectedItemIntoCenter, width]);

	const moveSelection = useCallback(
		(direction: "up" | "down") => {
			if (selectableIndices.length === 0) {
				return;
			}
			setSelectedIndex((currentIndex) => {
				const currentPosition = selectableIndices.indexOf(currentIndex);
				let nextPosition: number;
				if (direction === "down") {
					nextPosition =
						currentPosition < 0 ||
						currentPosition === selectableIndices.length - 1
							? 0
							: currentPosition + 1;
				} else {
					nextPosition =
						currentPosition <= 0
							? selectableIndices.length - 1
							: currentPosition - 1;
				}
				const nextIndex = selectableIndices[nextPosition] ?? currentIndex;
				selectedIndexRef.current = nextIndex;
				return nextIndex;
			});
		},
		[selectableIndices]
	);
	const moveUp = useCallback(() => moveSelection("up"), [moveSelection]);
	const moveDown = useCallback(() => moveSelection("down"), [moveSelection]);
	const handleEnter = useCallback(
		(onSelect: (item: T) => void) => {
			const item = filteredItems[selectedIndexRef.current];
			if (item !== undefined && isItemSelectable(item)) {
				onSelect(item);
			}
		},
		[filteredItems, isItemSelectable]
	);

	return {
		contentHeight,
		filteredItems,
		handleContentChange,
		handleEnter,
		inputRef,
		isItemActive,
		isItemSelectable,
		isScrollReady,
		moveDown,
		moveUp,
		query,
		scrollRef,
		selectedIndex,
	};
}
