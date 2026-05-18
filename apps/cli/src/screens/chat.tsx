import { useCompletion } from "@ai-sdk/react";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { honoClient } from "../lib/client";

const completionApi = honoClient.api.completion.$url().toString();

export function ChatScreen() {
	const prompt = useRouterState({
		select: (state) => state.location.state.input ?? "",
	});
	const submittedPromptRef = useRef<string | null>(null);
	const { complete, completion, error, isLoading } = useCompletion({
		api: completionApi,
		streamProtocol: "text",
	});

	useEffect(() => {
		const submittedPrompt = prompt.trim();
		if (!(submittedPrompt && submittedPromptRef.current !== submittedPrompt)) {
			return;
		}

		submittedPromptRef.current = submittedPrompt;
		complete(submittedPrompt).catch(() => undefined);
	}, [complete, prompt]);

	return (
		<box flexDirection="column">
			<text>Prompt:</text>
			<text>{prompt}</text>
			<text>Response:</text>
			<text>{completion}</text>
			{isLoading ? <text>Streaming...</text> : null}
			{error ? <text>{error.message}</text> : null}
		</box>
	);
}
