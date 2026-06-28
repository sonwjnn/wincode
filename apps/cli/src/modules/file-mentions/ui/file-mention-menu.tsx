import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/terminal/theme/theme-provider";
import type { FileMentionOption } from "../types";

const MAX_VISIBLE_ITEMS = 8;
const HEX_COLOR_RE = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/iu;

const getContrastingTextColor = (backgroundColor: string) => {
	const match = backgroundColor.match(HEX_COLOR_RE);
	if (!match) {
		return "black";
	}

	const red = Number.parseInt(match[1] ?? "0", 16);
	const green = Number.parseInt(match[2] ?? "0", 16);
	const blue = Number.parseInt(match[3] ?? "0", 16);
	const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

	return luminance > 0.55 ? "black" : "white";
};

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
				<text attributes={TextAttributes.DIM}>No matching files</text>
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
							fg={isSelected ? selectedTextColor : "white"}
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
