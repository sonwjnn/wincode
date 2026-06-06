import {
	type InputRenderable,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
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
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [searchValue, setSearchValue] = useState("");
	const inputRef = useRef<InputRenderable>(null);
	const selectedIndexRef = useRef(0);
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const { isTopLayer } = useKeyboardLayer();
	const { colors } = useTheme();

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
		: items;

	const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);

	useEffect(() => {
		selectedIndexRef.current = selectedIndex;
	}, [selectedIndex]);

	useEffect(() => {
		if (selectedIndex < filtered.length || filtered.length === 0) {
			return;
		}

		selectedIndexRef.current = filtered.length - 1;
		setSelectedIndex(filtered.length - 1);
	}, [filtered.length, selectedIndex]);

	useKeyboard((key) => {
		if (!isTopLayer("dialog")) {
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			const item = filtered[selectedIndexRef.current];
			if (item) {
				onSelect(item);
			}
		} else if (key.name === "up") {
			key.preventDefault();
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
				const item = filtered[newIndex];
				if (item && onHighlight) {
					onHighlight(item);
				}
				return newIndex;
			});
		} else if (key.name === "down") {
			key.preventDefault();
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
				const item = filtered[newIndex];
				if (item && onHighlight) {
					onHighlight(item);
				}
				return newIndex;
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
