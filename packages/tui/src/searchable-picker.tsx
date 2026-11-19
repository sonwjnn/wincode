import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useKeyboard, useTerminalDimensions } from "./react-hooks";
import { useTheme } from "./theme";

export type SearchablePickerItemState = Readonly<{
	isActive: boolean;
	isSearching: boolean;
	isSelected: boolean;
}>;

export type SearchablePickerProps<T> = Readonly<{
	emptyText?: string;
	footer?: ReactNode;
	getKey: (item: T) => string;
	getSearchText: (item: T) => string | readonly string[];
	initialSelectedIndex?: number;
	isItemActive?: (item: T) => boolean;
	isItemSelectable?: (item: T) => boolean;
	isKeyboardActive?: boolean;
	items: readonly T[];
	maxVisibleItems?: number;
	matchesSearch?: (item: T, query: string) => boolean;
	onHighlight?: (item: T) => void;
	onSelect: (item: T) => void;
	placeholder?: string;
	renderItem: (item: T, state: SearchablePickerItemState) => ReactNode;
}>;

const defaultSelectable = (): boolean => true;
const defaultActive = (): boolean => false;

function normalizeSearchText(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function matchesSubsequence(candidate: string, query: string): boolean {
	let candidateIndex = 0;
	for (const character of query) {
		const matchIndex = candidate.indexOf(character, candidateIndex);
		if (matchIndex < 0) {
			return false;
		}
		candidateIndex = matchIndex + character.length;
	}
	return true;
}

function matchesFuzzySearch(query: string, text: string): boolean {
	const normalizedQuery = normalizeSearchText(query);
	if (normalizedQuery.length === 0) {
		return query.length === 0;
	}

	const normalizedText = normalizeSearchText(text);
	const compactText = normalizedText.replaceAll(" ", "");
	return normalizedQuery.split(" ").every((token) => {
		const compactToken = token.replaceAll(" ", "");
		return (
			normalizedText.includes(token) ||
			compactText.includes(compactToken) ||
			matchesSubsequence(compactText, compactToken)
		);
	});
}

function getInitialIndex<T>(
	items: readonly T[],
	isItemActive: (item: T) => boolean,
	isItemSelectable: (item: T) => boolean,
	initialSelectedIndex: number | undefined
): number {
	if (initialSelectedIndex !== undefined) {
		return Math.max(
			0,
			Math.min(initialSelectedIndex, Math.max(0, items.length - 1))
		);
	}
	const activeIndex = items.findIndex(isItemActive);
	if (activeIndex >= 0) {
		return activeIndex;
	}
	const selectableIndex = items.findIndex(isItemSelectable);
	return Math.max(0, selectableIndex);
}

export function SearchablePicker<T>({
	emptyText = "No results",
	footer,
	getKey,
	getSearchText,
	initialSelectedIndex,
	isItemActive = defaultActive,
	isItemSelectable = defaultSelectable,
	isKeyboardActive = true,
	items,
	maxVisibleItems,
	matchesSearch,
	onHighlight,
	onSelect,
	placeholder = "Search",
	renderItem,
}: SearchablePickerProps<T>) {
	const { height } = useTerminalDimensions();
	const { colors } = useTheme();
	const initialIndex = getInitialIndex(
		items,
		isItemActive,
		isItemSelectable,
		initialSelectedIndex
	);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);
	const inputRef = useRef<InputRenderable>(null);
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const filterItems = useCallback(
		(searchQuery: string) =>
			searchQuery.length === 0
				? items
				: items.filter((item) => {
						if (matchesSearch) {
							return matchesSearch(item, searchQuery);
						}
						const searchText = getSearchText(item);
						return typeof searchText === "string"
							? matchesFuzzySearch(searchQuery, searchText)
							: searchText.some((text) =>
									matchesFuzzySearch(searchQuery, text)
								);
					}),
		[items, matchesSearch, getSearchText]
	);
	const filteredItems = filterItems(query);
	const highlightedItem = filteredItems[selectedIndex];
	const visibleHeight = Math.max(
		1,
		Math.min(
			filteredItems.length || 1,
			maxVisibleItems ?? Math.max(1, Math.floor(height * 0.5))
		)
	);
	const selectionColor =
		typeof colors.selection === "string" ? colors.selection : colors.info;
	const textColor = typeof colors.text === "string" ? colors.text : colors.info;
	const mutedTextColor =
		typeof colors.textMuted === "string" ? colors.textMuted : colors.info;

	const handleContentChange = useCallback(() => {
		const nextQuery = inputRef.current?.value ?? "";
		setQuery(nextQuery);
		const nextItems = filterItems(nextQuery);
		setSelectedIndex(
			nextQuery.length === 0
				? getInitialIndex(
						items,
						isItemActive,
						isItemSelectable,
						initialSelectedIndex
					)
				: Math.max(0, nextItems.findIndex(isItemSelectable))
		);
	}, [
		filterItems,
		initialSelectedIndex,
		isItemActive,
		isItemSelectable,
		items,
	]);

	useEffect(() => {
		if (highlightedItem !== undefined) {
			onHighlight?.(highlightedItem);
		}
	}, [highlightedItem, onHighlight]);

	const scrollToHighlight = useCallback(() => {
		const scrollbox = scrollRef.current;
		if (!scrollbox || scrollbox.viewport.height <= 0) {
			return false;
		}
		const maxScrollTop = Math.max(
			0,
			filteredItems.length - scrollbox.viewport.height
		);
		scrollbox.scrollTo(
			Math.min(
				maxScrollTop,
				Math.max(0, selectedIndex - Math.floor(scrollbox.viewport.height / 2))
			)
		);
		return true;
	}, [filteredItems.length, selectedIndex]);

	useLayoutEffect(() => {
		scrollToHighlight();
	}, [scrollToHighlight]);

	useEffect(() => {
		if (scrollToHighlight()) {
			return;
		}
		const timeout = setTimeout(scrollToHighlight, 0);
		return () => clearTimeout(timeout);
	}, [scrollToHighlight]);

	useKeyboard((key) => {
		if (!isKeyboardActive) {
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			if (highlightedItem !== undefined && isItemSelectable(highlightedItem)) {
				onSelect(highlightedItem);
			}
		} else if (key.name === "up" || key.name === "down") {
			key.preventDefault();
			const selectableIndices = filteredItems.flatMap((item, index) =>
				isItemSelectable(item) ? [index] : []
			);
			if (selectableIndices.length === 0) {
				return;
			}
			setSelectedIndex((currentIndex) => {
				const currentPosition = selectableIndices.indexOf(currentIndex);
				let nextPosition: number;
				if (key.name === "down") {
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
				return selectableIndices[nextPosition] ?? currentIndex;
			});
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<input
				focused
				focusedTextColor={textColor}
				onContentChange={handleContentChange}
				placeholder={placeholder}
				placeholderColor={mutedTextColor}
				ref={inputRef}
				textColor={textColor}
			/>
			{filteredItems.length === 0 ? (
				<text fg={mutedTextColor} height={1}>
					{emptyText}
				</text>
			) : (
				<scrollbox
					height={visibleHeight}
					ref={scrollRef}
					verticalScrollbarOptions={{ visible: false }}
				>
					{filteredItems.map((item, index) => {
						const isSelected = index === selectedIndex;
						return (
							<Fragment key={getKey(item)}>
								{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events. */}
								<box
									backgroundColor={isSelected ? selectionColor : undefined}
									flexDirection="row"
									height={1}
									onMouseDown={() => {
										if (isItemSelectable(item)) {
											onSelect(item);
										}
									}}
									overflow="hidden"
								>
									{renderItem(item, {
										isActive: isItemActive(item),
										isSearching: query.length > 0,
										isSelected,
									})}
								</box>
							</Fragment>
						);
					})}
				</scrollbox>
			)}
			{footer ?? <text fg={mutedTextColor}>↑↓ navigate · enter select</text>}
		</box>
	);
}
