import { TextAttributes } from "@opentui/core";
import {
	type CommandItem,
	getCommandLabel,
} from "@/modules/commands/command-item";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const MAX_VISIBLE_ITEMS = 8;

// Keep descriptions aligned across every source: padding on both sides of the
// label plus the gap that separates it from the description column.
const LABEL_COLUMN_PADDING = 4;

type CommandMenuProps = {
	items: CommandItem[];
	labelWidth: number;
	selectedIndex: number;
	visibleStartIndex: number;
	onScroll: (direction: "up" | "down") => void;
	onSelect: (index: number) => void;
	onExecute: (index: number) => void;
};

export function CommandMenu({
	items,
	labelWidth,
	selectedIndex,
	visibleStartIndex,
	onScroll,
	onSelect,
	onExecute,
}: CommandMenuProps) {
	const { colors } = useTheme();
	const visibleHeight = Math.min(items.length, MAX_VISIBLE_ITEMS);

	if (items.length === 0) {
		return (
			<box paddingX={1}>
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					No matching commands
				</text>
			</box>
		);
	}

	const end = Math.min(visibleStartIndex + MAX_VISIBLE_ITEMS, items.length);
	const visibleSlice = items.slice(visibleStartIndex, end);

	return (
		<box
			flexDirection="column"
			height={visibleHeight}
			onMouseScroll={(event) => {
				if (event.scroll?.direction === "down") {
					onScroll("down");
				} else if (event.scroll?.direction === "up") {
					onScroll("up");
				}
			}}
		>
			{visibleSlice.map((item, i) => {
				const realIndex = visibleStartIndex + i;
				const isSelected = realIndex === selectedIndex;
				const selectedTextColor = getContrastingTextColor(colors.selection);

				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
					<box
						backgroundColor={isSelected ? colors.selection : undefined}
						flexDirection="row"
						height={1}
						key={item.value}
						onMouseDown={() => onExecute(realIndex)}
						onMouseMove={() => onSelect(realIndex)}
						overflow="hidden"
						paddingX={1}
					>
						<box flexShrink={0} width={labelWidth + LABEL_COLUMN_PADDING}>
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{getCommandLabel(item)}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
							>
								{item.description}
							</text>
						</box>
					</box>
				);
			})}
		</box>
	);
}
