import { useRouter } from "@tanstack/react-router";
import { createAgentTurnId } from "@wincode/agent-core";
import type {
	ProviderCollection,
	ProviderModel,
	ThinkingSelection,
} from "@wincode/ai";
import { getErrorMessage, isNull, isUndefined, logger } from "@wincode/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type EffectiveAgentSelection,
	resolveActiveAgentId,
	resolveInteractiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { ProjectTrustNotice } from "@/modules/project-trust/ui/project-trust-notice";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
	type InteractiveProviderControllerOptions,
} from "@/modules/providers/interactive-provider-controller";
import {
	arePluginProviderRegistrationsBoundToTrustedOwners,
	isAvailableProviderModelSelection,
	isPluginProviderSelectionBoundToTrustedOwner,
	type ProviderModelSelection,
	ProviderModelSelectionOwnershipError,
	UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE,
} from "@/modules/providers/provider-model-selection";
import {
	getInteractiveSessionHostManager,
	withSessionManagerWork,
} from "@/modules/sessions/host/session-host-manager";
import { createSessionUserMessage } from "@/modules/sessions/message";
import {
	createDefaultSessionProviderCollection,
	getPluginProviderRegistrationsFromCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
import { useSettingsHubDialog } from "@/modules/settings";
import { createSkillSnapshot } from "@/modules/skills";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	getInteractivePluginRuntime,
	getInteractiveProviderCollectionFactory,
} from "@/shared/runtime-context";
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
	providerCollection: Pick<ProviderCollection, "close">
): Promise<void> => {
	try {
		await providerCollection.close();
	} catch {
		logger.warn("Home ProviderCollection cleanup failed.");
	}
};

type HomeProviderCollection = ProviderCollection &
	Partial<
		Pick<
			InteractiveSessionProviderCollection,
			| "getPluginProviderComposition"
			| "getPluginProviderRegistrations"
			| "loginOpenAIOAuth"
			| "getDiscoverableProviderIds"
			| "getCompositionRevision"
			| "subscribeComposition"
			| "supportsModelDiscovery"
		>
	>;

const homeProviderControllerOptions = (
	providerCollection: HomeProviderCollection
): InteractiveProviderControllerOptions => ({
	...(providerCollection.getPluginProviderComposition === undefined
		? {}
		: {
				getPluginProviderComposition:
					providerCollection.getPluginProviderComposition,
			}),
	...(providerCollection.getPluginProviderRegistrations === undefined
		? {}
		: {
				getPluginProviderRegistrations:
					providerCollection.getPluginProviderRegistrations,
			}),
	getTrustedPluginProviderRegistrations: () =>
		getInteractivePluginRuntime()?.getProviderRegistrations() ?? [],
	getTrustedPluginProviderRuntime: () => getInteractivePluginRuntime(),
	withSessionWork: (action) =>
		withSessionManagerWork(getInteractiveSessionHostManager(), action),
	...(providerCollection.loginOpenAIOAuth === undefined
		? {}
		: { loginOpenAIOAuth: providerCollection.loginOpenAIOAuth }),
	...(providerCollection.getDiscoverableProviderIds === undefined
		? {}
		: {
				getDiscoverableProviderIds:
					providerCollection.getDiscoverableProviderIds,
			}),
	...(providerCollection.getCompositionRevision === undefined
		? {}
		: {
				getCompositionRevision: providerCollection.getCompositionRevision,
			}),
	...(providerCollection.subscribeComposition === undefined
		? {}
		: { subscribeComposition: providerCollection.subscribeComposition }),
	...(providerCollection.supportsModelDiscovery === undefined
		? {}
		: {
				supportsModelDiscovery: providerCollection.supportsModelDiscovery,
			}),
});

type HomeProviderCollectionFactory = (
	pluginRuntime?: PluginRuntime
) => Promise<HomeProviderCollection>;

type NewSessionViewProps = Readonly<{
	createProviderCollection?: HomeProviderCollectionFactory;
}>;

type HomeSelectionPreflight =
	| Readonly<{ status: "pending" }>
	| Readonly<{ message: string; status: "error" }>
	| Readonly<{ selection: EffectiveAgentSelection; status: "ready" }>;

export function NewSessionView({
	createProviderCollection: providedCreateProviderCollection,
}: NewSessionViewProps) {
	const runtimeProviderCollectionFactory =
		getInteractiveProviderCollectionFactory();
	const createProviderCollection = useCallback(
		async (pluginRuntime?: PluginRuntime): Promise<HomeProviderCollection> => {
			if (providedCreateProviderCollection !== undefined) {
				return await providedCreateProviderCollection(pluginRuntime);
			}
			if (runtimeProviderCollectionFactory === undefined) {
				return await createDefaultSessionProviderCollection(pluginRuntime);
			}
			const collection = await runtimeProviderCollectionFactory(pluginRuntime);
			if (collection === undefined) {
				throw new Error(
					"ProviderCollection is unavailable in this Interactive runtime."
				);
			}
			return collection;
		},
		[providedCreateProviderCollection, runtimeProviderCollectionFactory]
	);
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [providerController, setProviderController] =
		useState<InteractiveProviderController>();
	const [initialProviderId, setInitialProviderId] = useState<string>();
	const [restoredModelSelection, setRestoredModelSelection] =
		useState<ProviderModelSelection>();
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
	const selectionPreflight = useMemo<HomeSelectionPreflight>(() => {
		if (
			registry === null ||
			!isPromptConfigRestored ||
			initializedDefaultAgentId !== defaultAgentId
		) {
			return { status: "pending" };
		}
		try {
			const selection = resolveInteractiveAgentSelection(
				registry,
				agent,
				model,
				thinkingLevel === undefined ? {} : { thinkingLevel },
				submissionSelectionOverride,
				pluginRuntime?.getProviderRegistrations() ?? [],
				restoredModelSelection
			);
			if (selection.unavailableReason !== undefined) {
				return { message: selection.unavailableReason, status: "error" };
			}
			return { selection, status: "ready" };
		} catch (selectionError) {
			return {
				message: getErrorMessage(
					selectionError,
					"Could not verify the selected Provider SDK Model."
				),
				status: "error",
			};
		}
	}, [
		agent,
		defaultAgentId,
		initializedDefaultAgentId,
		thinkingLevel,
		isPromptConfigRestored,
		model,
		pluginRuntime,
		registry,
		restoredModelSelection,
		submissionSelectionOverride,
	]);

	useEffect(() => {
		if (selectionPreflight.status === "pending") {
			return;
		}
		if (selectionPreflight.status === "error") {
			setError(selectionPreflight.message);
			return;
		}
		setInitialProviderId(
			(current) => current ?? selectionPreflight.selection.model.providerId
		);
	}, [selectionPreflight]);

	useEffect(() => {
		if (initialProviderId === undefined) {
			return;
		}
		let active = true;
		let providerCollection: HomeProviderCollection | undefined;
		let closePromise: Promise<void> | undefined;
		const closeOwnedProviderCollection = (): Promise<void> => {
			if (providerCollection === undefined) {
				return Promise.resolve();
			}
			closePromise ??= closeHomeProviderCollection(providerCollection);
			return closePromise;
		};
		const openProviderSelection = async (): Promise<void> => {
			try {
				providerCollection = await createProviderCollection(pluginRuntime);
				const trustedRegistrations =
					pluginRuntime?.getProviderRegistrations() ?? [];
				if (
					!arePluginProviderRegistrationsBoundToTrustedOwners(
						trustedRegistrations,
						getPluginProviderRegistrationsFromCollection(providerCollection)
					)
				) {
					throw new Error(UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE);
				}
				const controller = createInteractiveProviderController(
					providerCollection,
					homeProviderControllerOptions(providerCollection)
				);
				await controller.restoreModels(initialProviderId);
				if (!active) {
					await closeOwnedProviderCollection();
					return;
				}
				setProviderController(controller);
			} catch (providerError) {
				await closeOwnedProviderCollection();
				if (active) {
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
	}, [initialProviderId, createProviderCollection, pluginRuntime]);

	useEffect(() => {
		if (
			selectionPreflight.status !== "ready" ||
			providerController === undefined
		) {
			return;
		}
		const loadCandidates =
			providerController.getAvailableProviderModelSelectionCandidates;
		if (loadCandidates === undefined) {
			return;
		}
		const providerId = selectionPreflight.selection.model.providerId;
		const loadAvailableModels = () => {
			void loadCandidates(providerId).catch(() => undefined);
		};
		const unsubscribeComposition =
			providerController.subscribeComposition?.(loadAvailableModels);
		const unsubscribeAvailability =
			providerController.subscribeAvailability?.(loadAvailableModels);
		loadAvailableModels();
		return () => {
			unsubscribeComposition?.();
			unsubscribeAvailability?.();
		};
	}, [providerController, selectionPreflight]);

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
		setRestoredModelSelection(undefined);

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

				setRestoredModelSelection(selection.model);
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
		let effective: EffectiveAgentSelection;
		try {
			effective = resolveInteractiveAgentSelection(
				registry,
				agent,
				model,
				currentThinkingSelection,
				submissionSelectionOverride,
				pluginRuntime?.getProviderRegistrations() ?? [],
				restoredModelSelection
			);
		} catch (selectionError) {
			setError(
				getErrorMessage(
					selectionError,
					"Could not verify the selected Provider SDK Model."
				)
			);
			return false;
		}
		if (effective.unavailableReason !== undefined) {
			setError(effective.unavailableReason);
			return false;
		}
		if (providerController === undefined) {
			setError("Provider SDK model selection is unavailable.");
			return false;
		}
		const trustedRegistrations =
			pluginRuntime?.getProviderRegistrations() ?? [];
		const collectionRegistrations =
			providerController.getPluginProviderRegistrations();
		if (
			!arePluginProviderRegistrationsBoundToTrustedOwners(
				trustedRegistrations,
				collectionRegistrations
			)
		) {
			setError(UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE);
			return false;
		}
		if (
			!isPluginProviderSelectionBoundToTrustedOwner(
				effective.model,
				trustedRegistrations,
				collectionRegistrations
			)
		) {
			setError(
				new ProviderModelSelectionOwnershipError(effective.model).message
			);
			return false;
		}
		let currentlyAvailableModels: readonly ProviderModel[];
		try {
			currentlyAvailableModels =
				(
					await providerController.getAvailableProviderModelSelectionCandidates?.(
						effective.model.providerId
					)
				)?.map(({ model }) => model) ?? [];
		} catch {
			setError("Could not verify the selected Provider SDK Model.");
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
				justifyContent="center"
				width="100%"
			>
				<AsciiArt />
			</box>
			<box flexDirection="column" flexShrink={0} paddingBottom={1} width="100%">
				{error === null ? null : <text fg={colors.error}>{error}</text>}
				<ChatTextArea
					disabled={isCreatingSession}
					draftKey={NEW_SESSION_DRAFT_KEY}
					id={NEW_SESSION_COMPOSER_ID}
					isSelectionReady={isPromptConfigRestored}
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
					statusBarThinkingSelection={
						selectionPreflight.status === "ready"
							? {
									thinkingLevel: selectionPreflight.selection.thinkingLevel,
								}
							: undefined
					}
					unavailableCommandCapabilities={HOME_UNAVAILABLE_COMMAND_CAPABILITIES}
				/>
				<box flexDirection="column" flexShrink={0} paddingLeft={1} width="100%">
					<box flexDirection="row" width="100%">
						<WorkspacePath />
					</box>
					<ProjectTrustNotice />
				</box>
			</box>
		</box>
	);
}
