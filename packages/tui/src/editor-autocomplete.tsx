import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "./react-hooks";
import { type TuiThemeColor, useTheme } from "./theme";

const DEFAULT_MAX_VISIBLE = 8;
const LABEL_COLUMN_PADDING = 4;

export type EditorAutocompleteItem = Readonly<{
	description?: string;
	id: string;
	label: string;
}>;

export type EditorAutocompleteProps<T extends EditorAutocompleteItem> =
	Readonly<{
		/** Whether this completion list is currently shown. */
		open: boolean;
		/** Whether this completion layer is allowed to handle keyboard input. */
		active: boolean;
		/** Fills unselected rows when the list overlays existing content. */
		backgroundColor?: string;
		emptyMessage: string;
		items: readonly T[];
		maxVisible?: number;
		onApply: (item: T, index: number) => void;
		onCancel: () => void;
		onSelectedIndexChange: (index: number) => void;
		selectedIndex: number;
		widthBasis?: readonly EditorAutocompleteItem[];
	}>;

const normalizeMaxVisible = (maxVisible: number): number =>
	Number.isFinite(maxVisible)
		? Math.max(1, Math.floor(maxVisible))
		: DEFAULT_MAX_VISIBLE;

const getVisibleRange = (
	selectedIndex: number,
	itemCount: number,
	maxVisible: number
): Readonly<{ endIndex: number; startIndex: number }> => {
	const visibleCount = Math.min(itemCount, maxVisible);
	const startIndex = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(visibleCount / 2),
			itemCount - visibleCount
		)
	);
	return { endIndex: startIndex + visibleCount, startIndex };
};

const getCurrentIndex = (selectedIndex: number, itemCount: number): number => {
	if (itemCount === 0) {
		return -1;
	}
	if (!Number.isFinite(selectedIndex)) {
		return 0;
	}
	return Math.max(0, Math.min(Math.trunc(selectedIndex), itemCount - 1));
};

const getColor = (color: TuiThemeColor | undefined): string | undefined =>
	typeof color === "string" ? color : undefined;

const getLabelWidth = (items: readonly EditorAutocompleteItem[]): number =>
	items.reduce(
		(width, item) => Math.max(width, Bun.stringWidth(item.label)),
		0
	);

export function EditorAutocomplete<T extends EditorAutocompleteItem>({
	active,
	backgroundColor,
	emptyMessage,
	items,
	open,
	maxVisible = DEFAULT_MAX_VISIBLE,
	onApply,
	onCancel,
	onSelectedIndexChange,
	selectedIndex,
	widthBasis,
}: EditorAutocompleteProps<T>) {
	const { colors } = useTheme();
	const visibleLimit = normalizeMaxVisible(maxVisible);
	const currentIndex = getCurrentIndex(selectedIndex, items.length);
	const visibleHeight = Math.min(items.length, visibleLimit);
	const borderColor = getColor(colors.borderActive) ?? colors.info;
	const selectionColor = getColor(colors.selection) ?? colors.info;
	const textColor = getColor(colors.text);
	const selectedTextColor =
		getColor(colors.textOnSelection) ?? textColor ?? "#ffffff";
	const mutedTextColor = getColor(colors.textMuted);

	useKeyboard((key) => {
		if (!(open && active)) {
			return;
		}

		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			onCancel();
			return;
		}

		if (items.length === 0) {
			return;
		}

		if (key.name === "up" || key.name === "down") {
			const direction = key.name === "down" ? 1 : -1;
			const nextIndex =
				(currentIndex + direction + items.length) % items.length;
			key.preventDefault();
			key.stopPropagation();
			onSelectedIndexChange(nextIndex);
			return;
		}

		if (key.name === "enter" || key.name === "return") {
			const item = items[currentIndex];
			if (item === undefined) {
				return;
			}
			key.preventDefault();
			key.stopPropagation();
			onApply(item, currentIndex);
		}
	});

	if (!open) {
		return null;
	}

	if (items.length === 0) {
		return (
			<box
				backgroundColor={backgroundColor}
				border={["left", "right"]}
				borderColor={borderColor}
				width="100%"
			>
				<box paddingX={1}>
					<text fg={mutedTextColor}>{emptyMessage}</text>
				</box>
			</box>
		);
	}

	const { endIndex, startIndex } = getVisibleRange(
		currentIndex,
		items.length,
		visibleLimit
	);
	const visibleItems = items.slice(startIndex, endIndex);
	const layoutItems = widthBasis ?? items;
	const hasDescriptions = layoutItems.some(
		(item) => item.description !== undefined
	);
	const labelColumnWidth = hasDescriptions
		? getLabelWidth(layoutItems) + LABEL_COLUMN_PADDING
		: undefined;

	return (
		<box
			backgroundColor={backgroundColor}
			border={["left", "right"]}
			borderColor={borderColor}
			flexDirection="column"
			width="100%"
		>
			<box
				flexDirection="column"
				height={visibleHeight}
				onMouseScroll={(event) => {
					const direction = event.scroll?.direction;
					if (direction !== "up" && direction !== "down") {
						return;
					}
					const offset = direction === "down" ? 1 : -1;
					onSelectedIndexChange(
						Math.max(0, Math.min(currentIndex + offset, items.length - 1))
					);
				}}
				overflow="hidden"
			>
				{visibleItems.map((item, index) => {
					const itemIndex = startIndex + index;
					const isSelected = itemIndex === currentIndex;
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
						<box
							backgroundColor={isSelected ? selectionColor : backgroundColor}
							flexDirection="row"
							height={1}
							key={item.id}
							onMouseDown={() => onApply(item, itemIndex)}
							overflow="hidden"
							paddingX={1}
						>
							<box
								flexGrow={hasDescriptions ? 0 : 1}
								flexShrink={0}
								width={labelColumnWidth}
							>
								<text
									attributes={isSelected ? TextAttributes.INVERSE : undefined}
									fg={isSelected ? selectedTextColor : textColor}
									selectable={false}
								>
									{item.label}
								</text>
							</box>
							{hasDescriptions ? (
								<box flexGrow={1} flexShrink={1} overflow="hidden">
									<text
										attributes={isSelected ? TextAttributes.INVERSE : undefined}
										fg={isSelected ? selectedTextColor : mutedTextColor}
										selectable={false}
									>
										{item.description}
									</text>
								</box>
							) : null}
						</box>
					);
				})}
			</box>
		</box>
	);
}
