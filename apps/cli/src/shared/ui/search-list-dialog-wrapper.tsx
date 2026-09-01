import type { RGBA } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type ReactNode, useEffect } from "react";
import { useSearchableList } from "../hooks/use-searchable-list";
import { useDialogLayer } from "../providers/dialog/dialog-provider";
import { useKeyboardLayer } from "../providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "../providers/theme/theme-provider";

const MAX_VISIBLE_ITEMS = 6;
type KeyboardKey = Parameters<Parameters<typeof useKeyboard>[0]>[0];

const getInitialSelectedIndex = <T,>(
	items: readonly T[],
	isItemActive: ((item: T) => boolean) | undefined,
	isItemSelectable: (item: T) => boolean
): number => {
	const activeIndex = isItemActive ? items.findIndex(isItemActive) : -1;
	return Math.max(
		0,
		activeIndex >= 0 ? activeIndex : items.findIndex(isItemSelectable)
	);
};

type SearchListDialogWrapperProps<T> = {
	items: readonly T[];
	onSelect: (item: T) => void;
	onHighlight?: (item: T) => void;
	filterFn: (item: T, query: string) => boolean;
	renderItem: (
		item: T,
		isSelected: boolean,
		isActive: boolean,
		isSearching: boolean
	) => ReactNode;
	getKey: (item: T) => string;
	isItemActive?: (item: T) => boolean;
	isItemSelectable?: (item: T) => boolean;
	placeholder?: string;
	showSearch?: boolean;
	emptyText?: string;
	initialSelectedIndex?: number;
	maxVisibleItems?: number;
	minVisibleItems?: number;
	footer?: ReactNode;
	getItemBackgroundColor?: (
		item: T,
		isSelected: boolean
	) => string | RGBA | undefined;
	onKey?: (
		key: KeyboardKey,
		highlightedItem: T | undefined,
		isSearching: boolean
	) => boolean;
};

export function SearchListDialogWrapper<T>({
	items,
	onSelect,
	onHighlight,
	filterFn,
	renderItem,
	getKey,
	isItemActive,
	isItemSelectable = () => true,
	placeholder = "Search",
	emptyText = "No results",
	showSearch = true,
	initialSelectedIndex = getInitialSelectedIndex(
		items,
		isItemActive,
		isItemSelectable
	),
	maxVisibleItems = MAX_VISIBLE_ITEMS,
	minVisibleItems = 0,
	footer,
	getItemBackgroundColor,
	onKey,
}: SearchListDialogWrapperProps<T>) {
	const {
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
	} = useSearchableList(
		items,
		filterFn,
		initialSelectedIndex,
		isItemSelectable
	);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();

	const visibleHeight = Math.max(
		minVisibleItems,
		Math.min(filtered.length, maxVisibleItems)
	);
	const highlightedItem = filtered[selectedIndex];

	useEffect(() => {
		if (highlightedItem) {
			onHighlight?.(highlightedItem);
		}
	}, [highlightedItem, onHighlight]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (onKey?.(key, highlightedItem, searchValue.length > 0)) {
			key.preventDefault();
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
			{showSearch ? (
				<input
					focused
					focusedTextColor={colors.text}
					marginX={4}
					onContentChange={handleContentChange}
					placeholder={placeholder}
					placeholderColor={colors.textMuted}
					ref={inputRef}
					textColor={colors.text}
				/>
			) : null}
			{filtered.length === 0 ? (
				<text
					attributes={TextAttributes.DIM}
					fg={colors.textMuted}
					height={visibleHeight}
					marginBottom={1}
					marginX={4}
				>
					{emptyText}
				</text>
			) : (
				<scrollbox
					height={visibleHeight}
					opacity={isScrollReady ? 1 : 0}
					ref={scrollRef}
					verticalScrollbarOptions={{ visible: false }}
				>
					{filtered.map((item, i) => {
						const isSelected = i === selectedIndex;
						const selectable = isItemSelectable(item);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
							<box
								backgroundColor={
									getItemBackgroundColor?.(item, isSelected) ??
									(isSelected ? colors.selection : undefined)
								}
								flexDirection="row"
								height={1}
								key={getKey(item)}
								marginX={1}
								onMouseDown={() => selectable && onSelect(item)}
								onMouseMove={() => {
									if (!selectable) {
										return;
									}
									selectedIndexRef.current = i;
									setSelectedIndex(i);
								}}
								overflow="hidden"
							>
								{renderItem(
									item,
									isSelected,
									isItemActive?.(item) ?? false,
									searchValue.length > 0
								)}
							</box>
						);
					})}
				</scrollbox>
			)}
			{footer}
		</box>
	);
}
