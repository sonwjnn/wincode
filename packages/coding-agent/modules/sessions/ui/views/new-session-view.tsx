import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { createAgentTurnId } from "@wincode/agent-core";
import { createReasoningSelection } from "@wincode/ai/models";
import { isNull, isUndefined } from "@wincode/utils";
import { useEffect, useState } from "react";
import {
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { PluginStatusIndicator } from "@/modules/plugins/ui/plugin-status-indicator";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { createSessionUserMessage } from "@/modules/sessions/message";
import { useSettingsHubDialog } from "@/modules/settings";
import { createSkillSnapshot } from "@/modules/skills";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { useUiComponentFocus } from "@/shared/ui/ui-component-registry";
import { resolveLastUsedSessionSelection } from "../../selection";
import { getSessionStore } from "../../storage/get-session-store";
import { projectSessionRecords } from "../../storage/session-record";
import { type ChatPromptSubmission, getMostRecentSession } from "../../utils";
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

export const hasChatPromptContent = ({
	files,
	skill,
	text,
}: ChatPromptSubmission): boolean =>
	text.trim().length > 0 || files.length > 0 || !isUndefined(skill);

const HOME_UNAVAILABLE_COMMAND_CAPABILITIES = ["compaction"] as const;

const NEW_SESSION_DRAFT_KEY = "new-session";
const NEW_SESSION_VIEW_ID = "new-session-view";
const NEW_SESSION_COMPOSER_ID = `${NEW_SESSION_VIEW_ID}-composer`;

export function NewSessionView() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const focusHandlers = useUiComponentFocus({
		componentId: NEW_SESSION_COMPOSER_ID,
		enabled: !isCreatingSession,
		scopeId: NEW_SESSION_VIEW_ID,
	});
	const [isPromptConfigRestored, setIsPromptConfigRestored] = useState(false);
	const [initializedDefaultAgentId, setInitializedDefaultAgentId] = useState<
		string | undefined
	>();
	const {
		agent,
		effort,
		model,
		reasoningMode,
		setAgent,
		setEffort,
		setModel,
		setReasoningMode,
	} = usePromptConfig();
	const currentReasoningSelection = createReasoningSelection(
		effort,
		reasoningMode
	);
	const openSettings = useSettingsHubDialog();
	const { colors } = useTheme();
	const { show } = useToast();
	const registry = useAgentRegistry();
	const defaultAgentId = registry?.defaultAgentId;

	useEffect(() => {
		if (!isUndefined(defaultAgentId)) {
			setAgent(defaultAgentId);
			setInitializedDefaultAgentId(defaultAgentId);
		}
	}, [defaultAgentId, setAgent]);

	useEffect(() => {
		if (isNull(registry)) {
			setIsPromptConfigRestored(false);
			return;
		}
		let ignore = false;
		setIsPromptConfigRestored(false);

		const restoreLatestSessionConfig = async () => {
			try {
				const store = getSessionStore();
				const session = getMostRecentSession(await store.listSessions());
				if (!session) {
					return;
				}

				const selection = resolveLastUsedSessionSelection({
					messages: projectSessionRecords(
						await store.listSessionRecords(session.id)
					),
					resolveAgent: (agentId) => resolveActiveAgentId(registry, agentId),
					sessionModel: session.model,
					sessionEffort: session.effort,
					sessionReasoningMode: session.reasoningMode,
				});
				if (ignore || !selection) {
					return;
				}
				if (!isUndefined(selection.agent)) {
					setAgent(selection.agent);
				}

				setModel(selection.model);
				if (selection.effort === undefined) {
					setReasoningMode(selection.reasoningMode);
				} else {
					setEffort(selection.effort);
				}
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
	}, [registry, setAgent, setEffort, setModel, setReasoningMode]);

	const handleSubmit = async (submission: ChatPromptSubmission) => {
		const { files, skill, text } = submission;
		const prompt = text.trim();
		if (
			!canSubmitHomePrompt({
				defaultAgentId,
				initializedDefaultAgentId,
				isCreatingSession,
				isPromptConfigRestored,
				registryReady: !isNull(registry),
			})
		) {
			return false;
		}

		if (!hasChatPromptContent(submission)) {
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
			currentReasoningSelection
		);
		const initialMessage = createSessionUserMessage(
			input,
			{
				agent: effective.agent,
				model: effective.model,
				effort: effective.effort,
				reasoningMode: effective.reasoningMode,
				...(skill ? { skill: createSkillSnapshot(skill, "explicit") } : {}),
			},
			fileMentions,
			files
		);
		const store = getSessionStore();
		const [externalized] = await store.externalizeAttachments(
			[initialMessage],
			undefined,
			{ rejectInvalid: true }
		);
		const durableMessage = externalized ?? initialMessage;
		const { id } = await store.createSession({
			agent: effective.agent,
			message: durableMessage,
			model,
			turnId: createAgentTurnId(),
			effort,
			reasoningMode,
		});
		await router.navigate({
			params: { id },
			state: (previous) => ({
				...previous,
				initialSubmission: { messageId: initialMessage.id },
			}),
			to: "/sessions/$id",
		});
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
		<box
			flexDirection="column"
			height="100%"
			id={NEW_SESSION_VIEW_ID}
			onMouseDown={focusHandlers.onMouseDown}
			onMouseMove={focusHandlers.onMouseMove}
			width="100%"
		>
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
						draftKey={NEW_SESSION_DRAFT_KEY}
						id={NEW_SESSION_COMPOSER_ID}
						onCompact={() => {
							show({
								message: "Compaction is unavailable without an active session.",
								variant: "error",
							});
							return false;
						}}
						onOpenSettings={openSettings}
						onSubmit={handleSubmit}
						unavailableCommandCapabilities={
							HOME_UNAVAILABLE_COMMAND_CAPABILITIES
						}
					/>
					<box
						flexDirection="row"
						flexShrink={0}
						gap={2}
						justifyContent="space-between"
						width="100%"
					>
						<WorkspacePath />
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
				<PluginStatusIndicator />
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{`v${APP_VERSION}`}
				</text>
			</box>
		</box>
	);
}
