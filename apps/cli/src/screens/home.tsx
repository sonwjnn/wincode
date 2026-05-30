import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { createUserMessage } from "@wincode/ai/client";
import { useState } from "react";
import { AsciiArt } from "../components/ascii-art";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { honoClient } from "../lib/client";
import { usePromptConfig } from "../providers/prompt-config";

export function HomeScreen() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const { mode } = usePromptConfig();

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
			json: {
				message: createUserMessage(input),
				mode,
			},
		});

		if (!response.ok) {
			setError("Could not create chat session.");
			return;
		}

		const { id } = await response.json();
		await router.navigate({
			params: { id },
			state: { mode },
			to: "/sessions/$id",
		});
	};

	return (
		<box
			alignItems="center"
			flexGrow={1}
			gap={2}
			height="100%"
			justifyContent="center"
			position="relative"
			width="100%"
		>
			<AsciiArt />
			<box
				flexDirection="column"
				gap={1}
				maxWidth={78}
				paddingX={2}
				width="100%"
			>
				<ChatTextArea
					disabled={isCreatingSession}
					focused={!isCreatingSession}
					onSubmit={handleSubmit}
					placeholder={
						isCreatingSession
							? "Creating session..."
							: "What would you like to build?"
					}
				/>
				<box flexDirection="row" flexShrink={0} gap={1} marginLeft="auto">
					<text>tab</text>
					<text attributes={TextAttributes.DIM}>agents</text>
				</box>
			</box>
		</box>
	);
}
