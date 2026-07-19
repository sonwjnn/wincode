import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { createUserMessage } from "@wincode/ai/client";
import { useEffect, useState } from "react";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { getConversationStore } from "../../storage/get-conversation-store";
import { getLatestChatConfig, getMostRecentSession } from "../../utils";
import { AsciiArt } from "../components/ascii-art";
import type { ChatPromptSubmission } from "../components/chat-text-area";
import { ChatTextArea } from "../components/chat-text-area";

export function HomeView() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const { mode, model, setMode, setModel, setVariant, variant } =
		usePromptConfig();

	useEffect(() => {
		let ignore = false;

		const restoreLatestSessionConfig = async () => {
			const store = getConversationStore();
			const session = getMostRecentSession(await store.listSessions());
			if (!session) {
				return;
			}

			const config = getLatestChatConfig(await store.getMessages(session.id));
			if (ignore || !config) {
				return;
			}

			setMode(config.mode);
			setModel(config.model);
			setVariant(config.variant);
		};

		restoreLatestSessionConfig().catch(() => undefined);

		return () => {
			ignore = true;
		};
	}, [setMode, setModel, setVariant]);

	const handleSubmit = async ({ files, text }: ChatPromptSubmission) => {
		if (isCreatingSession) {
			return false;
		}
		const prompt = text.trim();

		if (!(prompt || files.length > 0)) {
			return false;
		}

		setError(null);
		setIsCreatingSession(true);

		try {
			await createSession(prompt, files);
			return true;
		} catch {
			setError("Could not create chat session.");
			return false;
		} finally {
			setIsCreatingSession(false);
		}
	};

	const createSession = async (
		input: string,
		files: ChatPromptSubmission["files"]
	) => {
		const fileMentions = await resolveFileMentionParts(input);
		const { id } = await getConversationStore().createSession({
			message: createUserMessage(
				input,
				{ mode, model, variant },
				fileMentions,
				files
			),
			mode,
			model,
		});

		await router.navigate({
			params: { id },
			state: { autoStart: true, mode },
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
				<ChatTextArea disabled={isCreatingSession} onSubmit={handleSubmit} />
				<box flexDirection="row" flexShrink={0} gap={1} marginLeft="auto">
					<text>tab</text>
					<text attributes={TextAttributes.DIM}>agents</text>
				</box>
			</box>
		</box>
	);
}
