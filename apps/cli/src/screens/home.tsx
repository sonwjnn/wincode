import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { getCodingMode } from "@wincode/ai";
import { createUserMessage } from "@wincode/ai/client";
import { useState } from "react";
import { AsciiArt } from "../components/ascii-art";
import {
	ChatTextArea,
	getChatTextAreaWidth,
} from "../components/chat/chat-text-area";
import { honoClient } from "../lib/client";
import { usePromptConfig } from "../providers/prompt-config-provider";

export function HomeScreen() {
	const { width } = useTerminalDimensions();
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const { cycleMode, modeName } = usePromptConfig();
	const promptWidth = getChatTextAreaWidth(width, 72);

	useKeyboard((key) => {
		if (key.name !== "tab" || key.repeated || isCreatingSession) {
			return;
		}

		cycleMode();
	});

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
				mode: modeName,
			},
		});

		if (!response.ok) {
			setError("Could not create chat session.");
			return;
		}

		const { id } = await response.json();
		await router.navigate({
			params: { id },
			state: { mode: modeName },
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
				<box flexDirection="row" gap={2} marginTop={1}>
					<text attributes={TextAttributes.DIM}>
						Mode: {getCodingMode(modeName).displayName}
					</text>
					<text attributes={TextAttributes.DIM}>Tab mode</text>
				</box>
			</box>
		</box>
	);
}
