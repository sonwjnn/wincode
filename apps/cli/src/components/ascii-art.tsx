import { useTerminalDimensions } from "@opentui/react";

export function HomeScreen() {
	const { width } = useTerminalDimensions();

	return (
		<box alignItems="center" flexDirection="column">
			<ascii-font font="tiny" text="WinCode" />
			<textarea
				focused
				height={10}
				placeholder="What would you like to build?"
				width={width - 10}
			/>
		</box>
	);
}
