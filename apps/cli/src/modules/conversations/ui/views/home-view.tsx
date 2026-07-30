import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { createUserMessage } from "@wincode/ai/client";
import { useEffect, useState } from "react";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getConversationStore } from "../../storage/get-conversation-store";
import type { ChatPromptSubmission } from "../../utils";
import { getLatestChatConfig, getMostRecentSession } from "../../utils";
import { AsciiArt } from "../components/ascii-art";
import { ChatTextArea } from "../components/chat-text-area";
import { WorkspacePath } from "../components/workspace-path";

export function HomeView() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const { mode, model, setMode, setModel, setVariant, variant } =
		usePromptConfig();
	const { colors } = useTheme();

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
		<box flexDirection="column" height="100%" width="100%">
			<box
				alignItems="center"
				flexGrow={1}
				gap={2}
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
					<box flexDirection="row" flexShrink={0} gap={1}>
						<text fg={colors.text}>tab</text>
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							agents
						</text>
					</box>
				</box>
			</box>

			<box
				flexDirection="row"
				flexShrink={0}
				gap={2}
				justifyContent="space-between"
				paddingBottom={1}
				paddingX={2}
				width="100%"
			>
				<WorkspacePath />
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{`v${APP_VERSION}`}
				</text>
			</box>
		</box>
	);
}
