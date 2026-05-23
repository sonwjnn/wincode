import { useTerminalDimensions } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { AsciiArt } from "../components/ascii-art";
import {
	ChatTextArea,
	getChatTextAreaWidth,
} from "../components/chat/chat-text-area";

export function HomeScreen() {
	const { width } = useTerminalDimensions();
	const router = useRouter();
	const promptWidth = getChatTextAreaWidth(width, 72);

	const handleSubmit = (input: string) => {
		router.navigate({ to: "/chat", state: { input } });
	};

	return (
		<box alignItems="center" flexDirection="column" marginTop={4}>
			<AsciiArt />
			<box flexDirection="column" marginTop={2} width={promptWidth}>
				<ChatTextArea
					height={6}
					onSubmit={handleSubmit}
					placeholder="What would you like to build?"
				/>
			</box>
		</box>
	);
}
