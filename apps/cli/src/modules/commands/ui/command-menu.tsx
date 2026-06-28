import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/terminal/theme/theme-provider";
import { COMMANDS, type CommandSpec } from "../commands";

const MAX_VISIBLE_ITEMS = 8;

// Align all command names in a fixed-width column so their descriptions
// start at the same horizontal position for a clean tabular look.
// The width adjusts to accommodate the longest command name.
const COMMAND_COL_WIDTH =
	Math.max(...COMMANDS.map((cmd) => cmd.name.length)) + 4;

type CommandMenuProps = {
	commands: CommandSpec[];
	selectedIndex: number;
	visibleStartIndex: number;
	onSelect: (index: number) => void;
	onExecute: (index: number) => void;
};

export function CommandMenu({
	commands,
	selectedIndex,
	visibleStartIndex,
	onSelect,
	onExecute,
}: CommandMenuProps) {
	const { colors } = useTheme();
	const visibleHeight = Math.min(commands.length, MAX_VISIBLE_ITEMS);

	if (commands.length === 0) {
		return (
			<box paddingX={1}>
				<text attributes={TextAttributes.DIM}>No matching commands</text>
			</box>
		);
	}

	const end = Math.min(visibleStartIndex + MAX_VISIBLE_ITEMS, commands.length);
	const visibleSlice = commands.slice(visibleStartIndex, end);

	return (
		<box flexDirection="column" height={visibleHeight}>
			{visibleSlice.map((cmd, i) => {
				const realIndex = visibleStartIndex + i;
				const isSelected = realIndex === selectedIndex;

				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
					<box
						backgroundColor={isSelected ? colors.selection : undefined}
						flexDirection="row"
						height={1}
						key={cmd.value}
						onMouseDown={() => onExecute(realIndex)}
						onMouseMove={() => onSelect(realIndex)}
						overflow="hidden"
						paddingX={1}
					>
						<box flexShrink={0} width={COMMAND_COL_WIDTH}>
							<text fg={isSelected ? "black" : "white"} selectable={false}>
								/{cmd.name}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text fg={isSelected ? "black" : "gray"} selectable={false}>
								{cmd.description}
							</text>
						</box>
					</box>
				);
			})}
		</box>
	);
}
