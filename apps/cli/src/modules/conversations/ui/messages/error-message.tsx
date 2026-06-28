import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { EmptyBorder } from "@/shared/terminal/ui/borders";

type ErrorMessageProps = {
	message: string;
};

export function ErrorMessage({ message }: ErrorMessageProps) {
	const { colors } = useTheme();

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={colors.error}
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
					<text attributes={TextAttributes.DIM}>{message}</text>
				</box>
			</box>
		</box>
	);
}
