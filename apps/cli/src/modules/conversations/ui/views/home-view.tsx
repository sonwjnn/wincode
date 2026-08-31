import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { createUserMessage } from "@wincode/ai/client";
import { useEffect, useState } from "react";
import {
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { useCompactionSettingsDialog } from "@/modules/conversations/compaction";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { McpActiveIndicator } from "@/modules/mcp";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { createSkillSnapshot } from "@/modules/skills";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { resolveLastUsedConversationSelection } from "../../selection";
import { getConversationStore } from "../../storage/get-conversation-store";
import type { ChatPromptSubmission } from "../../utils";
import { getMostRecentSession } from "../../utils";
import { AsciiArt } from "../components/ascii-art";
import { ChatTextArea } from "../components/chat-text-area";
import { WorkspacePath } from "../components/workspace-path";

type HomePromptReadiness = {
	defaultAgentId: string | undefined;
	initializedDefaultAgentId: string | undefined;
	isCreatingSession: boolean;
	isPromptConfigRestored: boolean;
	registryReady: boolean;
};

export const canSubmitHomePrompt = ({
	defaultAgentId,
	initializedDefaultAgentId,
	isCreatingSession,
	isPromptConfigRestored,
	registryReady,
}: HomePromptReadiness): boolean =>
	!isCreatingSession &&
	isPromptConfigRestored &&
	registryReady &&
	initializedDefaultAgentId === defaultAgentId;

export function HomeView() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [isPromptConfigRestored, setIsPromptConfigRestored] = useState(false);
	const [initializedDefaultAgentId, setInitializedDefaultAgentId] = useState<
		string | undefined
	>();
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const openCompactionSettingsDialog = useCompactionSettingsDialog();
	const { colors } = useTheme();
	const registry = useAgentRegistry();
	const defaultAgentId = registry?.defaultAgentId;
	const openCompactionSettings = () => openCompactionSettingsDialog(model);

	useEffect(() => {
		if (defaultAgentId !== undefined) {
			setAgent(defaultAgentId);
			setInitializedDefaultAgentId(defaultAgentId);
		}
	}, [defaultAgentId, setAgent]);

	useEffect(() => {
		if (registry === null) {
			setIsPromptConfigRestored(false);
			return;
		}
		let ignore = false;
		setIsPromptConfigRestored(false);

		const restoreLatestSessionConfig = async () => {
			try {
				const store = getConversationStore();
				const session = getMostRecentSession(await store.listSessions());
				if (!session) {
					return;
				}

				const selection = resolveLastUsedConversationSelection({
					messages: await store.getMessages(session.id),
					resolveAgent: (agentId) => resolveActiveAgentId(registry, agentId),
					sessionModel: session.model,
					sessionVariant: session.variant,
				});
				if (ignore || !selection) {
					return;
				}
				if (selection.agent !== undefined) {
					setAgent(selection.agent);
				}

				setModel(selection.model);
				setVariant(selection.variant);
			} finally {
				if (!ignore) {
					setIsPromptConfigRestored(true);
				}
			}
		};

		restoreLatestSessionConfig().catch(() => undefined);

		return () => {
			ignore = true;
		};
	}, [registry, setAgent, setModel, setVariant]);

	const handleSubmit = async ({ files, skill, text }: ChatPromptSubmission) => {
		if (
			!canSubmitHomePrompt({
				defaultAgentId,
				initializedDefaultAgentId,
				isCreatingSession,
				isPromptConfigRestored,
				registryReady: registry !== null,
			})
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
					model: effective.model,
					variant: effective.variant,
					...(skill ? { skill: createSkillSnapshot(skill, "explicit") } : {}),
				},
				fileMentions,
				files
			),
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
					<ChatTextArea
						disabled={isCreatingSession}
						onOpenCompaction={openCompactionSettings}
						onSubmit={handleSubmit}
						showCompactCommand={false}
					/>
					<box
						flexDirection="row"
						flexShrink={0}
						gap={2}
						justifyContent="space-between"
						width="100%"
					>
						<WorkspacePath />
						<box flexDirection="row" flexShrink={0} gap={1}>
							<text fg={colors.text}>tab</text>
							<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
								agents
							</text>
						</box>
					</box>
				</box>
			</box>

			<box
				alignItems="center"
				flexDirection="row"
				flexShrink={0}
				gap={2}
				justifyContent="space-between"
				paddingBottom={1}
				paddingX={2}
				width="100%"
			>
				<McpActiveIndicator />
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{`v${APP_VERSION}`}
				</text>
			</box>
		</box>
	);
}
