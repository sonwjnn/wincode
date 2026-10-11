import type { RGBA } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { Fragment, type ReactNode, useCallback, useEffect } from "react";
import { fuzzyMatch } from "../fuzzy";
import { useSearchableList } from "../hooks/use-searchable-list";
import {
	DEFAULT_DIALOG_CONTENT_MARGIN,
	DEFAULT_DIALOG_LIST_ITEM_MARGIN,
} from "../providers/dialog/defaults";
import { useDialogLayer } from "../providers/dialog/dialog-provider";
import type { DialogMargin } from "../providers/dialog/types";
import { useKeyboardLayer } from "../providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "../providers/theme/theme-provider";
import { DialogFooterHint } from "./dialog-footer-hint";
import { DialogInset } from "./dialog-inset";

const MAX_VISIBLE_ITEMS = 6;
const DIALOG_SECTION_SPACING = 1;
type KeyboardKey = Parameters<Parameters<typeof useKeyboard>[0]>[0];
type SearchText = string | readonly string[];

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
	getSearchText: (item: T) => SearchText;
	renderItem: (
		item: T,
		isSelected: boolean,
		isActive: boolean,
		isSearching: boolean
	) => ReactNode;
	getKey: (item: T) => string;
	isItemActive?: (item: T) => boolean;
	isItemSelectable?: (item: T) => boolean;
	getItemSectionKey?: (item: T) => string | undefined;
	placeholder?: string;
	showSearch?: boolean;
	emptyText?: string;
	initialSelectedIndex?: number;
	maxVisibleItems?: number;
	minVisibleItems?: number;
	footer?: ReactNode;
	footerHints?: ReactNode;
	navigationHint?: ReactNode;
	contentMargin?: DialogMargin;
	footerMargin?: DialogMargin;
	itemMargin?: DialogMargin;
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
	getSearchText,
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
	footerHints,
	navigationHint = <DialogFooterHint label="navigate" shortcut="↑↓" />,
	contentMargin = DEFAULT_DIALOG_CONTENT_MARGIN,
	footerMargin = contentMargin,
	itemMargin = DEFAULT_DIALOG_LIST_ITEM_MARGIN,
	getItemBackgroundColor,
	getItemSectionKey,
	onKey,
}: SearchListDialogWrapperProps<T>) {
	const filterFn = useCallback(
		(item: T, query: string) => {
			const searchText = getSearchText(item);
			return typeof searchText === "string"
				? fuzzyMatch(query, searchText).matches
				: searchText.some((text) => fuzzyMatch(query, text).matches);
		},
		[getSearchText]
	);

	const getItemHeight = useCallback(
		(item: T, index: number, list: readonly T[]) => {
			if (index === 0 || !getItemSectionKey) {
				return 1;
			}
			const previousItem = list[index - 1];
			if (previousItem === undefined) {
				return 1;
			}
			const sectionKey = getItemSectionKey(item);
			if (
				sectionKey === undefined ||
				sectionKey === getItemSectionKey(previousItem)
			) {
				return 1;
			}
			return 1 + DIALOG_SECTION_SPACING;
		},
		[getItemSectionKey]
	);
	const {
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
	} = useSearchableList(
		items,
		filterFn,
		initialSelectedIndex,
		isItemSelectable,
		getItemHeight
	);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();

	const visibleHeight = Math.max(
		minVisibleItems,
		Math.min(contentHeight, maxVisibleItems)
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
					marginBottom={contentMargin.bottom}
					marginLeft={contentMargin.left}
					marginRight={contentMargin.right}
					marginTop={contentMargin.top}
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
					marginBottom={contentMargin.bottom ?? 1}
					marginLeft={contentMargin.left}
					marginRight={contentMargin.right}
					marginTop={contentMargin.top}
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
						const sectionSpacing = getItemHeight(item, i, filtered) - 1;
						return (
							<Fragment key={getKey(item)}>
								{sectionSpacing > 0 ? (
									<box
										height={sectionSpacing}
										marginLeft={itemMargin.left}
										marginRight={itemMargin.right}
									/>
								) : null}
								{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events. */}
								<box
									backgroundColor={
										getItemBackgroundColor?.(item, isSelected) ??
										(isSelected ? colors.selection : undefined)
									}
									flexDirection="row"
									height={1}
									marginBottom={itemMargin.bottom}
									marginLeft={itemMargin.left}
									marginRight={itemMargin.right}
									marginTop={itemMargin.top}
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
							</Fragment>
						);
					})}
				</scrollbox>
			)}
			{footer ? (
				<DialogInset margin={footerMargin}>{footer}</DialogInset>
			) : null}
			{navigationHint || footerHints ? (
				<DialogInset margin={contentMargin}>
					<box flexDirection="row" gap={2} height={1}>
						{navigationHint}
						{footerHints}
					</box>
				</DialogInset>
			) : null}
		</box>
	);
}
