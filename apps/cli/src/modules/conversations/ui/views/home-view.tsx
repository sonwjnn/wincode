import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { getLegacyModeForAgent } from "@wincode/ai";
import { createUserMessage } from "@wincode/ai/client";
import { useEffect, useState } from "react";
import {
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getConversationStore } from "../../storage/get-conversation-store";
import type { ChatPromptSubmission } from "../../utils";
import {
	createSkillSnapshot,
	getLatestChatConfig,
	getMostRecentSession,
} from "../../utils";
import { AsciiArt } from "../components/ascii-art";
import { ChatTextArea } from "../components/chat-text-area";
import { WorkspacePath } from "../components/workspace-path";

export function HomeView() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [initializedDefaultAgentId, setInitializedDefaultAgentId] = useState<
		string | undefined
	>();
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const { colors } = useTheme();
	const registry = useAgentRegistry();
	const defaultAgentId = registry?.defaultAgentId;

	useEffect(() => {
		if (defaultAgentId !== undefined) {
			setAgent(defaultAgentId);
			setInitializedDefaultAgentId(defaultAgentId);
		}
	}, [defaultAgentId, setAgent]);

	useEffect(() => {
		let ignore = false;

		const restoreLatestSessionConfig = async () => {
			const store = getConversationStore();
			const session = getMostRecentSession(await store.listSessions());
			if (!session) {
				return;
			}

			const config = session.model
				? { model: session.model, variant: session.variant }
				: getLatestChatConfig(await store.getMessages(session.id));
			if (ignore || !config) {
				return;
			}

			setModel(config.model);
			setVariant(config.variant);
		};

		restoreLatestSessionConfig().catch(() => undefined);

		return () => {
			ignore = true;
		};
	}, [setModel, setVariant]);

	const handleSubmit = async ({ files, skill, text }: ChatPromptSubmission) => {
		if (
			isCreatingSession ||
			registry === null ||
			initializedDefaultAgentId !== defaultAgentId
		) {
			return false;
		}
		const prompt = text.trim();

		if (!(prompt || files.length > 0)) {
			return false;
		}

		setError(null);
		setIsCreatingSession(true);

		try {
			await createSession(prompt, files, skill);
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
		files: ChatPromptSubmission["files"],
		skill: ChatPromptSubmission["skill"]
	) => {
		const fileMentions = await resolveFileMentionParts(input);
		const effective = resolveEffectiveAgentSelection(
			registry,
			agent,
			model,
			variant
		);
		const { id } = await getConversationStore().createSession({
			agent: effective.agent,
			message: createUserMessage(
				input,
				{
					agent: effective.agent,
					mode: getLegacyModeForAgent(effective.agent),
					model: effective.model,
					variant: effective.variant,
					...(skill ? { skill: createSkillSnapshot(skill) } : {}),
				},
				fileMentions,
				files
			),
			mode: getLegacyModeForAgent(effective.agent),
			model,
			variant,
		});

		await router.navigate({
			params: { id },
			state: { agent: effective.agent, autoStart: true },
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
