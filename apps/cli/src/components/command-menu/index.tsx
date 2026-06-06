import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import type { RefObject } from "react";
import { useTheme } from "../../providers/theme";
import { COMMANDS, type CommandSpec } from "./commands";

const MAX_VISIBLE_ITEMS = 8;

// Align all command names in a fixed-width column so their descriptions
// start at the same horizontal position for a clean tabular look.
// The width adjusts to accommodate the longest command name.
const COMMAND_COL_WIDTH =
	Math.max(...COMMANDS.map((cmd) => cmd.name.length)) + 4;

type CommandMenuProps = {
	commands: CommandSpec[];
	selectedIndex: number;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	onSelect: (index: number) => void;
	onExecute: (index: number) => void;
};

export function CommandMenu({
	commands,
	selectedIndex,
	scrollRef,
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

	return (
		<scrollbox height={visibleHeight} ref={scrollRef}>
			{commands.map((cmd, i) => {
				const isSelected = i === selectedIndex;

				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
					<box
						backgroundColor={isSelected ? colors.selection : undefined}
						flexDirection="row"
						height={1}
						key={cmd.value}
						onMouseDown={() => onExecute(i)}
						onMouseMove={() => onSelect(i)}
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
		</scrollbox>
	);
}
