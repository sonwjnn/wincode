import { findSubsequenceMatch, normalizeForSearch } from "@wincode/utils";
import { Fragment, type ReactNode, useCallback, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "./react-hooks";
import { useSearchableList } from "./searchable-list";
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

function matchesFuzzySearch(query: string, text: string): boolean {
	const normalizedQuery = normalizeForSearch(query);
	if (normalizedQuery.length === 0) {
		return query.length === 0;
	}

	const normalizedText = normalizeForSearch(text);
	const compactText = normalizedText.replaceAll(" ", "");
	return normalizedQuery.split(" ").every((token) => {
		const compactToken = token.replaceAll(" ", "");
		return (
			normalizedText.includes(token) ||
			compactText.includes(compactToken) ||
			findSubsequenceMatch(compactText, compactToken) !== null
		);
	});
}

export function SearchablePicker<T>({
	emptyText = "No results",
	footer,
	getKey,
	getSearchText,
	initialSelectedIndex,
	isItemActive,
	isItemSelectable,
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
	const filterFn = useCallback(
		(item: T, query: string) => {
			if (matchesSearch) {
				return matchesSearch(item, query);
			}
			const searchText = getSearchText(item);
			return typeof searchText === "string"
				? matchesFuzzySearch(query, searchText)
				: searchText.some((text) => matchesFuzzySearch(query, text));
		},
		[matchesSearch, getSearchText]
	);
	const {
		filteredItems,
		handleContentChange,
		handleEnter,
		inputRef,
		isItemActive: isActive,
		isItemSelectable: isSelectable,
		moveDown,
		moveUp,
		query,
		scrollRef,
		selectedIndex,
	} = useSearchableList({
		filterFn,
		initialSelectedIndex,
		isItemActive,
		isItemSelectable,
		items,
	});
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

	useEffect(() => {
		if (highlightedItem !== undefined) {
			onHighlight?.(highlightedItem);
		}
	}, [highlightedItem, onHighlight]);

	useKeyboard((key) => {
		if (!isKeyboardActive) {
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			handleEnter(onSelect);
		} else if (key.name === "up") {
			key.preventDefault();
			moveUp();
		} else if (key.name === "down") {
			key.preventDefault();
			moveDown();
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<input
				focused={isKeyboardActive}
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
										if (isSelectable(item)) {
											onSelect(item);
										}
									}}
									overflow="hidden"
								>
									{renderItem(item, {
										isActive: isActive(item),
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
