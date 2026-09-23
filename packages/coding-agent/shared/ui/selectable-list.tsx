import { TextAttributes } from "@opentui/core";
import { getContrastingTextColor } from "../providers/theme/color-contrast";
import { useTheme } from "../providers/theme/theme-provider";

const DEFAULT_SELECTABLE_LIST_MAX_VISIBLE = 8;
const LABEL_COLUMN_PADDING = 4;

export type SelectableListItem = Readonly<{
	id: string;
	label: string;
	description?: string;
}>;
export type SelectableListRange = Readonly<{
	endIndex: number;
	startIndex: number;
}>;

export type SelectableListProps = Readonly<{
	emptyMessage: string;
	items: readonly SelectableListItem[];
	maxVisible?: number;
	onConfirm: (index: number) => void;
	onSelect: (index: number) => void;
	selectedIndex: number;
	/**
	 * Complete item set used to keep description columns stable when items are filtered.
	 */
	widthBasis?: readonly SelectableListItem[];
}>;

const normalizeMaxVisible = (maxVisible: number): number =>
	Number.isFinite(maxVisible)
		? Math.max(1, Math.floor(maxVisible))
		: DEFAULT_SELECTABLE_LIST_MAX_VISIBLE;

export const getSelectableListRange = (
	selectedIndex: number,
	itemCount: number,
	maxVisible = DEFAULT_SELECTABLE_LIST_MAX_VISIBLE
): SelectableListRange => {
	if (itemCount <= 0) {
		return { endIndex: 0, startIndex: 0 };
	}

	const visibleCount = Math.min(itemCount, normalizeMaxVisible(maxVisible));
	const safeSelectedIndex = Number.isFinite(selectedIndex)
		? Math.trunc(selectedIndex)
		: 0;
	const clampedSelectedIndex = Math.max(
		0,
		Math.min(safeSelectedIndex, itemCount - 1)
	);
	const startIndex = Math.max(
		0,
		Math.min(
			clampedSelectedIndex - Math.floor(visibleCount / 2),
			itemCount - visibleCount
		)
	);

	return {
		endIndex: startIndex + visibleCount,
		startIndex,
	};
};

const getLabelWidth = (items: readonly SelectableListItem[]): number =>
	items.reduce(
		(width, item) => Math.max(width, globalThis.Bun.stringWidth(item.label)),
		0
	);

const getNextIndex = (
	selectedIndex: number,
	direction: "up" | "down",
	itemCount: number
): number => {
	const currentIndex = Number.isFinite(selectedIndex)
		? Math.max(0, Math.min(Math.trunc(selectedIndex), itemCount - 1))
		: 0;
	return direction === "down"
		? Math.min(itemCount - 1, currentIndex + 1)
		: Math.max(0, currentIndex - 1);
};

export function SelectableList({
	emptyMessage,
	items,
	maxVisible = DEFAULT_SELECTABLE_LIST_MAX_VISIBLE,
	onConfirm,
	onSelect,
	selectedIndex,
	widthBasis,
}: SelectableListProps) {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const visibleHeight = Math.min(items.length, normalizeMaxVisible(maxVisible));

	if (items.length === 0) {
		return (
			<box paddingX={1}>
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{emptyMessage}
				</text>
			</box>
		);
	}

	const { endIndex, startIndex } = getSelectableListRange(
		selectedIndex,
		items.length,
		maxVisible
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
			flexDirection="column"
			height={visibleHeight}
			onMouseScroll={(event) => {
				const direction = event.scroll?.direction;
				if (direction !== "up" && direction !== "down") {
					return;
				}
				onSelect(getNextIndex(selectedIndex, direction, items.length));
			}}
		>
			{visibleItems.map((item, index) => {
				const realIndex = startIndex + index;
				const isSelected = realIndex === selectedIndex;

				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
					<box
						backgroundColor={isSelected ? colors.selection : undefined}
						flexDirection="row"
						height={1}
						key={item.id}
						onMouseDown={() => onConfirm(realIndex)}
						onMouseMove={() => onSelect(realIndex)}
						overflow="hidden"
						paddingX={1}
					>
						<box
							flexGrow={hasDescriptions ? 0 : 1}
							flexShrink={0}
							width={labelColumnWidth}
						>
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{item.label}
							</text>
						</box>
						{hasDescriptions ? (
							<box flexGrow={1} flexShrink={1} overflow="hidden">
								<text
									fg={isSelected ? selectedTextColor : colors.textMuted}
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
	);
}
