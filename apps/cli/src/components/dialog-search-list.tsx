import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import { useSearchableList } from "../hooks/use-searchable-list";
import { useDialogLayer } from "../providers/dialog";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";

const MAX_VISIBLE_ITEMS = 6;

type DialogSearchListProps<T> = {
	items: readonly T[];
	onSelect: (item: T) => void;
	onHighlight?: (item: T) => void;
	filterFn: (item: T, query: string) => boolean;
	renderItem: (item: T, isSelected: boolean) => ReactNode;
	getKey: (item: T) => string;
	placeholder?: string;
	emptyText?: string;
};

export function DialogSearchList<T>({
	items,
	onSelect,
	onHighlight,
	filterFn,
	renderItem,
	getKey,
	placeholder = "Search",
	emptyText = "No results",
}: DialogSearchListProps<T>) {
	const {
		filtered,
		selectedIndex,
		selectedIndexRef,
		setSelectedIndex,
		inputRef,
		scrollRef,
		handleContentChange,
		moveUp,
		moveDown,
		handleEnter,
	} = useSearchableList(items, filterFn);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();

	const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			handleEnter(onSelect);
		} else if (key.name === "up") {
			key.preventDefault();
			moveUp(() => {
				const item = filtered[selectedIndexRef.current];
				if (item && onHighlight) {
					onHighlight(item);
				}
			});
		} else if (key.name === "down") {
			key.preventDefault();
			moveDown(() => {
				const item = filtered[selectedIndexRef.current];
				if (item && onHighlight) {
					onHighlight(item);
				}
			});
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<input
				focused
				onContentChange={handleContentChange}
				placeholder={placeholder}
				ref={inputRef}
			/>
			{filtered.length === 0 ? (
				<text attributes={TextAttributes.DIM}>{emptyText}</text>
			) : (
				<scrollbox height={visibleHeight} ref={scrollRef}>
					{filtered.map((item, i) => {
						const isSelected = i === selectedIndex;
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
							<box
								backgroundColor={isSelected ? colors.selection : undefined}
								flexDirection="row"
								height={1}
								key={getKey(item)}
								onMouseDown={() => onSelect(item)}
								onMouseMove={() => {
									selectedIndexRef.current = i;
									setSelectedIndex(i);
									if (onHighlight) {
										onHighlight(item);
									}
								}}
								overflow="hidden"
							>
								{renderItem(item, isSelected)}
							</box>
						);
					})}
				</scrollbox>
			)}
		</box>
	);
}
