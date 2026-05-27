import { useTerminalDimensions } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { createUserMessage } from "@wincode/ai/client";
import { useState } from "react";
import { AsciiArt } from "../components/ascii-art";
import {
	ChatTextArea,
	getChatTextAreaWidth,
} from "../components/chat/chat-text-area";
import { honoClient } from "../lib/client";

export function HomeScreen() {
	const { width } = useTerminalDimensions();
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const promptWidth = getChatTextAreaWidth(width, 72);

	const handleSubmit = async (input: string) => {
		if (isCreatingSession) {
			return;
		}
		const prompt = input.trim();

		if (!prompt) {
			return;
		}

		setError(null);
		setIsCreatingSession(true);

		try {
			await createSession(prompt);
		} catch {
			setError("Could not create chat session.");
		} finally {
			setIsCreatingSession(false);
		}
	};

	const createSession = async (input: string) => {
		const response = await honoClient.api.sessions.$post({
			json: { message: createUserMessage(input) },
		});

		if (!response.ok) {
			setError("Could not create chat session.");
			return;
		}

		const { id } = await response.json();
		await router.navigate({
			params: { id },
			to: "/sessions/$id",
		});
	};

	return (
		<box alignItems="center" flexDirection="column" marginTop={4}>
			<AsciiArt />
			<box flexDirection="column" marginTop={2} width={promptWidth}>
				{error ? <text fg="red">{error}</text> : null}
				<ChatTextArea
					focused={!isCreatingSession}
					height={6}
					onSubmit={handleSubmit}
					placeholder={
						isCreatingSession
							? "Creating session..."
							: "What would you like to build?"
					}
				/>
			</box>
		</box>
	);
}
