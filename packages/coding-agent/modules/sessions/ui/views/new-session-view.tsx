import { TextAttributes } from "@opentui/core";
import { useRouter } from "@tanstack/react-router";
import { createAgentTurnId } from "@wincode/agent-core";
import type { ThinkingSelection } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import { getErrorMessage, isNull, isUndefined, logger } from "@wincode/utils";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
	withAvailableAgentModelOverride,
} from "@/modules/agents";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { PluginStatusIndicator } from "@/modules/plugins/ui/plugin-status-indicator";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import { isAvailableProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { createSessionUserMessage } from "@/modules/sessions/message";
import {
	createDefaultSessionProviderCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
import { useSettingsHubDialog } from "@/modules/settings";
import { createSkillSnapshot } from "@/modules/skills";
import { APP_VERSION } from "@/shared/app-info";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { getInteractivePluginRuntime } from "@/shared/runtime-context";
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

const closeHomeProviderCollection = async (
	providerCollection: InteractiveSessionProviderCollection
): Promise<void> => {
	try {
		await providerCollection.close();
	} catch {
		logger.warn("Home ProviderCollection cleanup failed.");
	}
};

type HomeProviderCollectionFactory = (
	pluginRuntime?: PluginRuntime
) => Promise<InteractiveSessionProviderCollection>;

type NewSessionViewProps = Readonly<{
	createProviderCollection?: HomeProviderCollectionFactory;
}>;

export function NewSessionView({
	createProviderCollection = createDefaultSessionProviderCollection,
}: NewSessionViewProps) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [providerController, setProviderController] =
		useState<InteractiveProviderController>();
	const [availableProviderModels, setAvailableProviderModels] = useState<
		readonly ProviderModel[]
	>([]);
	const [isLoadingProviderModels, setIsLoadingProviderModels] = useState(true);
	const [isLoadingProviderCollection, setIsLoadingProviderCollection] =
		useState(true);
	const pluginRuntime = getInteractivePluginRuntime();
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
		model,
		thinkingLevel,
		setAgent,
		setModel,
		setThinkingLevel,
		submissionSelectionOverride,
	} = usePromptConfig();
	const currentThinkingSelection: ThinkingSelection =
		thinkingLevel === undefined ? {} : { thinkingLevel };
	const openSettings = useSettingsHubDialog();
	const { colors } = useTheme();
	const { show } = useToast();
	const registry = useAgentRegistry();
	const defaultAgentId = registry?.defaultAgentId;

	useEffect(() => {
		let active = true;
		let providerCollection: InteractiveSessionProviderCollection | undefined;
		let closePromise: Promise<void> | undefined;
		const closeOwnedProviderCollection = (): Promise<void> => {
			if (providerCollection === undefined) {
				return Promise.resolve();
			}
			closePromise ??= closeHomeProviderCollection(providerCollection);
			return closePromise;
		};
		setIsLoadingProviderCollection(true);
		const openProviderSelection = async (): Promise<void> => {
			try {
				providerCollection = await createProviderCollection(pluginRuntime);
				const controller = createInteractiveProviderController(
					providerCollection,
					{
						getPluginProviderComposition:
							providerCollection.getPluginProviderComposition,
						getPluginProviderRegistrations:
							providerCollection.getPluginProviderRegistrations,
						loginOpenAIOAuth: providerCollection.loginOpenAIOAuth,
						getDiscoverableProviderIds:
							providerCollection.getDiscoverableProviderIds,
						getCompositionRevision: providerCollection.getCompositionRevision,
						subscribeComposition: providerCollection.subscribeComposition,
						supportsModelDiscovery: providerCollection.supportsModelDiscovery,
					}
				);
				await controller.restoreModels();
				if (!active) {
					await closeOwnedProviderCollection();
					return;
				}
				setProviderController(controller);
				setIsLoadingProviderCollection(false);
			} catch (providerError) {
				await closeOwnedProviderCollection();
				if (active) {
					setIsLoadingProviderCollection(false);
					setError(
						getErrorMessage(
							providerError,
							"Provider SDK model selection is unavailable."
						)
					);
				}
			}
		};
		void openProviderSelection();
		return () => {
			active = false;
			void closeOwnedProviderCollection();
		};
	}, [createProviderCollection, pluginRuntime]);

	const subscribeProviderAvailability = useCallback(
		(listener: () => void) => {
			const unsubscribeComposition =
				providerController?.subscribeComposition?.(listener) ??
				(() => undefined);
			const unsubscribeAvailability =
				providerController?.subscribeAvailability?.(listener) ??
				(() => undefined);
			return () => {
				unsubscribeComposition();
				unsubscribeAvailability();
			};
		},
		[providerController]
	);
	const getProviderAvailabilityRevision = useCallback(
		() =>
			`${providerController?.getCompositionRevision?.() ?? 0}:${providerController?.getAvailabilityRevision?.() ?? 0}`,
		[providerController]
	);
	const providerAvailabilityRevision = useSyncExternalStore(
		subscribeProviderAvailability,
		getProviderAvailabilityRevision,
		getProviderAvailabilityRevision
	);
	useEffect(() => {
		if (providerController === undefined) {
			setAvailableProviderModels([]);
			setIsLoadingProviderModels(true);
			return;
		}
		let active = true;
		const requestedRevision = providerAvailabilityRevision;
		setIsLoadingProviderModels(true);
		void providerController
			.getAvailableModels()
			.then((models) => {
				if (active && getProviderAvailabilityRevision() === requestedRevision) {
					setAvailableProviderModels(models);
				}
			})
			.catch(() => {
				if (active && getProviderAvailabilityRevision() === requestedRevision) {
					setAvailableProviderModels([]);
				}
			})
			.finally(() => {
				if (active && getProviderAvailabilityRevision() === requestedRevision) {
					setIsLoadingProviderModels(false);
				}
			});
		return () => {
			active = false;
		};
	}, [
		getProviderAvailabilityRevision,
		providerAvailabilityRevision,
		providerController,
	]);
	const currentProviderModelAvailable = isAvailableProviderModelSelection(
		model,
		availableProviderModels
	);
	const providerModelStatus = (() => {
		if (isLoadingProviderCollection || isLoadingProviderModels) {
			return <text fg={colors.textMuted}>Loading Provider SDK Models…</text>;
		}
		if (providerController === undefined) {
			return (
				<text fg={colors.error}>
					Provider SDK Model selection is unavailable.
				</text>
			);
		}
		if (currentProviderModelAvailable) {
			return (
				<text fg={colors.textMuted}>
					{`Provider Model: ${model.providerId}/${model.modelId}`}
				</text>
			);
		}
		return (
			<text fg={colors.error}>
				{`Stored default unavailable: ${model.providerId}/${model.modelId}. Connect a Provider and choose an available Model with /provider-models.`}
			</text>
		);
	})();

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
					sessionThinkingLevel: session.thinkingLevel,
				});
				if (ignore || !selection) {
					return;
				}
				if (!isUndefined(selection.agent)) {
					setAgent(selection.agent);
				}

				setModel(selection.model);
				setThinkingLevel(selection.thinkingLevel);
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
	}, [registry, setAgent, setModel, setThinkingLevel]);

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
			return await createSession(prompt, files, skill);
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
	): Promise<boolean> => {
		if (providerController === undefined) {
			setError("Provider SDK model selection is unavailable.");
			return false;
		}
		let currentlyAvailableModels: readonly ProviderModel[];
		try {
			currentlyAvailableModels = await providerController.getAvailableModels();
		} catch {
			setError("Could not verify the selected Provider SDK Model.");
			return false;
		}
		const selectionOverride = withAvailableAgentModelOverride(
			registry,
			agent,
			submissionSelectionOverride,
			currentlyAvailableModels
		);
		const effective = resolveEffectiveAgentSelection(
			registry,
			agent,
			model,
			currentThinkingSelection,
			false,
			selectionOverride
		);
		if (effective.unavailableReason !== undefined) {
			setError(effective.unavailableReason);
			return false;
		}
		if (
			!isAvailableProviderModelSelection(
				effective.model,
				currentlyAvailableModels
			)
		) {
			setError(
				`Provider Model ${effective.model.providerId}/${effective.model.modelId} is unavailable. Connect a Provider and explicitly select an available Provider SDK Model.`
			);
			return false;
		}
		const fileMentions = await resolveFileMentionParts(input);
		const initialMessage = createSessionUserMessage(
			input,
			{
				agent: effective.agent,
				model: effective.model,
				thinkingLevel: effective.thinkingLevel,
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
			model: effective.model,
			turnId: createAgentTurnId(),
			thinkingLevel: effective.thinkingLevel,
		});
		await router.navigate({
			params: { id },
			state: (previous) => ({
				...previous,
				initialSubmission: { messageId: initialMessage.id },
			}),
			to: "/sessions/$id",
		});
		return true;
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
					{providerModelStatus}
					{error === null ? null : <text fg={colors.error}>{error}</text>}
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
						providerController={providerController}
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
