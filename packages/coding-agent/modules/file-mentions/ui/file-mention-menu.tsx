import { TextAttributes } from "@opentui/core";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { FileMentionOption } from "../types";

const MAX_VISIBLE_ITEMS = 8;
type FileMentionMenuProps = {
	items: FileMentionOption[];
	selectedIndex: number;
	visibleStartIndex: number;
	onSelect: (index: number) => void;
	onExecute: (index: number) => void;
};

export function FileMentionMenu({
	items,
	selectedIndex,
	visibleStartIndex,
	onSelect,
	onExecute,
}: FileMentionMenuProps) {
	const { colors } = useTheme();
	const visibleHeight = Math.min(items.length, MAX_VISIBLE_ITEMS);
	const selectedTextColor = getContrastingTextColor(colors.selection);

	if (items.length === 0) {
		return (
			<box paddingX={1}>
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					No matching files
				</text>
			</box>
		);
	}

	const end = Math.min(visibleStartIndex + MAX_VISIBLE_ITEMS, items.length);
	const visibleSlice = items.slice(visibleStartIndex, end);

	return (
		<box flexDirection="column" height={visibleHeight}>
			{visibleSlice.map((item, i) => {
				const realIndex = visibleStartIndex + i;
				const isSelected = realIndex === selectedIndex;

				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
					<box
						backgroundColor={isSelected ? colors.selection : undefined}
						flexDirection="row"
						height={1}
						key={item.path}
						onMouseDown={() => onExecute(realIndex)}
						onMouseMove={() => onSelect(realIndex)}
						overflow="hidden"
						paddingX={1}
					>
						<text
							fg={isSelected ? selectedTextColor : colors.text}
							selectable={false}
						>
							{isSelected ? <strong>{item.label}</strong> : item.label}
						</text>
					</box>
				);
			})}
		</box>
	);
}
