import type { ModeType } from "@wincode/ai";
import { useTheme } from "../../../providers/theme";
import { EmptyBorder } from "../../border";

type UserMessageProps = {
	message: string;
	mode: ModeType;
};

export function UserMessage({ message, mode }: UserMessageProps) {
	const { colors } = useTheme();
	const borderColor = colors.mode[mode];

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={borderColor}
				customBorderChars={{
					...EmptyBorder,
					bottomLeft: "╹",
					vertical: "┃",
				}}
				width="100%"
			>
				<box
					backgroundColor={colors.surface}
					justifyContent="center"
					paddingBottom={1}
					paddingTop={1}
					paddingX={2}
					width="100%"
				>
					<text>{message}</text>
				</box>
			</box>
		</box>
	);
}
