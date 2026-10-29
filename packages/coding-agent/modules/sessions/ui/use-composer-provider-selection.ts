import type { ProviderModel, ThinkingSelection } from "@wincode/ai";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPluginPromptSelectionTarget } from "@/modules/application/plugin-prompt-selection";
import type { CommandCapability } from "@/modules/commands/commands";
import type { PromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import {
	clampProviderModelThinkingSelection,
	isAvailableProviderModelSelection,
	isSameProviderModelIdentity,
	pluginProviderOwnerMatches,
	supportedProviderThinkingLevels,
} from "@/modules/providers/provider-model-selection";
import { useLatest } from "@/shared/hooks/use-latest";
import { getInteractivePluginRuntime } from "@/shared/runtime-context";

export type ComposerProviderSelectionOptions = Readonly<{
	disabled: boolean;
	isSelectionReady: boolean;
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onProviderModelChanged?: () => void;
	providerController?: InteractiveProviderController;
	sessionId?: string;
	statusBarThinkingSelection?: ThinkingSelection;
	unavailableCommandCapabilities: readonly CommandCapability[];
}>;

export type ComposerProviderSelection = Readonly<{
	cycleThinkingLevel: PromptConfig["cycleThinkingLevel"];
	hasThinkingLevels: boolean;
	isProviderStatusReady: boolean;
	selectedProviderModel: ProviderModel | undefined;
	setFutureProviderModelSelection: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => void;
	thinkingLevel: PromptConfig["thinkingLevel"];
	unavailableCommandCapabilities: CommandCapability[];
}>;

type KnownProviderModels = Readonly<{
	controller: InteractiveProviderController;
	providerId: string;
	compositionRevision: number;
	availabilityRevision: number;
	models: readonly ProviderModel[];
}>;

export const useComposerProviderSelection = ({
	disabled,
	isSelectionReady,
	onCompact,
	onProviderModelChanged,
	providerController,
	sessionId,
	statusBarThinkingSelection,
	unavailableCommandCapabilities: viewUnavailableCapabilities,
}: ComposerProviderSelectionOptions): ComposerProviderSelection => {
	const {
		agent,
		cycleThinkingLevel,
		model,
		thinkingLevel,
		setModelForFutureSubmissions,
		setThinkingLevelForFutureSubmissions,
	} = usePromptConfig();
	const subscribeProviderComposition = useCallback(
		(listener: () => void) =>
			providerController?.subscribeComposition?.(listener) ?? (() => undefined),
		[providerController]
	);
	const getProviderCompositionRevision = useCallback(
		() => providerController?.getCompositionRevision?.() ?? 0,
		[providerController]
	);
	const providerCompositionRevision = useSyncExternalStore(
		subscribeProviderComposition,
		getProviderCompositionRevision,
		getProviderCompositionRevision
	);
	const subscribeProviderAvailability = useCallback(
		(listener: () => void) =>
			providerController?.subscribeAvailability?.(listener) ??
			(() => undefined),
		[providerController]
	);
	const getProviderAvailabilityRevision = useCallback(
		() => providerController?.getAvailabilityRevision?.() ?? 0,
		[providerController]
	);
	const providerAvailabilityRevision = useSyncExternalStore(
		subscribeProviderAvailability,
		getProviderAvailabilityRevision,
		getProviderAvailabilityRevision
	);
	const [knownProviderModels, setKnownProviderModels] =
		useState<KnownProviderModels | null>(null);
	useEffect(() => {
		let active = true;
		if (providerController === undefined) {
			setKnownProviderModels(null);
			return () => {
				active = false;
			};
		}
		const requestedCompositionRevision = providerCompositionRevision;
		const requestedAvailabilityRevision = providerAvailabilityRevision;
		const isCurrentRevision = () =>
			getProviderCompositionRevision() === requestedCompositionRevision &&
			getProviderAvailabilityRevision() === requestedAvailabilityRevision;
		void providerController
			.getKnownModels(model.providerId)
			.then((models) => {
				if (active && isCurrentRevision()) {
					setKnownProviderModels({
						controller: providerController,
						providerId: model.providerId,
						compositionRevision: requestedCompositionRevision,
						availabilityRevision: requestedAvailabilityRevision,
						models,
					});
				}
			})
			.catch(() => {
				if (active && isCurrentRevision()) {
					setKnownProviderModels({
						controller: providerController,
						providerId: model.providerId,
						compositionRevision: requestedCompositionRevision,
						availabilityRevision: requestedAvailabilityRevision,
						models: [],
					});
				}
			});
		return () => {
			active = false;
		};
	}, [
		getProviderAvailabilityRevision,
		getProviderCompositionRevision,
		providerAvailabilityRevision,
		providerCompositionRevision,
		providerController,
		model.providerId,
	]);
	const isProviderStatusReady =
		knownProviderModels !== null &&
		knownProviderModels.controller === providerController &&
		knownProviderModels.providerId === model.providerId &&
		knownProviderModels.compositionRevision === providerCompositionRevision &&
		knownProviderModels.availabilityRevision === providerAvailabilityRevision;
	const selectedProviderModel = isProviderStatusReady
		? knownProviderModels.models.find((providerModel) =>
				isSameProviderModelIdentity(providerModel, model)
			)
		: undefined;
	const initialThinkingResolved = useRef(false);
	useEffect(() => {
		if (
			initialThinkingResolved.current ||
			!isSelectionReady ||
			selectedProviderModel === undefined
		) {
			return;
		}
		initialThinkingResolved.current = true;
		if (
			thinkingLevel !== undefined ||
			statusBarThinkingSelection?.thinkingLevel !== undefined
		) {
			return;
		}
		const initialLevel = clampProviderModelThinkingSelection(
			selectedProviderModel,
			"low"
		).thinkingLevel;
		if (initialLevel !== undefined) {
			setThinkingLevelForFutureSubmissions(selectedProviderModel, initialLevel);
		}
	}, [
		isSelectionReady,
		selectedProviderModel,
		setThinkingLevelForFutureSubmissions,
		statusBarThinkingSelection?.thinkingLevel,
		thinkingLevel,
	]);
	const selectedProviderModelRef = useLatest(selectedProviderModel);
	const previousAgent = useRef(agent);
	useEffect(() => {
		if (previousAgent.current === agent) {
			return;
		}

		// Agent changes can replace system instructions and tools in the cached prefix.
		onProviderModelChanged?.();
		previousAgent.current = agent;
	}, [agent, onProviderModelChanged]);
	const {
		modelId: selectedModelId,
		pluginProviderSource,
		providerId: selectedProviderId,
	} = model;
	const setFutureModelSelection = useCallback(
		(
			nextProviderModel: ProviderModel,
			nextSelection: ProviderModelSelection
		) => {
			selectedProviderModelRef.current = nextProviderModel;
			if (
				!(
					isSameProviderModelIdentity(
						{ modelId: selectedModelId, providerId: selectedProviderId },
						nextSelection
					) &&
					pluginProviderOwnerMatches(
						pluginProviderSource,
						nextSelection.pluginProviderSource
					)
				)
			) {
				onProviderModelChanged?.();
			}
			setModelForFutureSubmissions(nextProviderModel, nextSelection);
		},
		[
			selectedModelId,
			selectedProviderId,
			pluginProviderSource,
			onProviderModelChanged,
			setModelForFutureSubmissions,
		]
	);
	const setFutureProviderModelSelection = useCallback(
		(nextModel: ProviderModel, selection: ProviderModelSelection) => {
			setKnownProviderModels((current) =>
				current === null ||
				isAvailableProviderModelSelection(selection, current.models)
					? current
					: { ...current, models: [...current.models, nextModel] }
			);
			setFutureModelSelection(nextModel, selection);
		},
		[setFutureModelSelection]
	);
	const pluginRuntime = getInteractivePluginRuntime();
	useEffect(() => {
		if (
			disabled ||
			pluginRuntime === undefined ||
			providerController === undefined
		) {
			return;
		}
		return pluginRuntime.bindPromptSelectionTarget(
			createPluginPromptSelectionTarget(
				providerController,
				{
					setModel: setFutureModelSelection,
					setThinkingLevel: (level) =>
						setThinkingLevelForFutureSubmissions(
							selectedProviderModelRef.current,
							level
						),
				},
				() =>
					getInteractivePluginRuntime()?.getProviderRegistrations(sessionId) ??
					[]
			)
		);
	}, [
		disabled,
		pluginRuntime,
		providerController,
		setFutureModelSelection,
		setThinkingLevelForFutureSubmissions,
		sessionId,
	]);
	const thinkingLevels =
		selectedProviderModel === undefined
			? []
			: supportedProviderThinkingLevels(selectedProviderModel);
	const unavailableCommandCapabilities = useMemo(() => {
		const unavailable = new Set<CommandCapability>(viewUnavailableCapabilities);
		if (!onCompact) {
			unavailable.add("compaction");
		}
		if (thinkingLevels.length === 0) {
			unavailable.add("thinking-level-selection");
		}
		if (providerController === undefined) {
			unavailable.add("provider-sdk");
		}
		return [...unavailable];
	}, [
		onCompact,
		providerController,
		thinkingLevels.length,
		viewUnavailableCapabilities,
	]);

	return {
		cycleThinkingLevel,
		hasThinkingLevels: thinkingLevels.length > 0,
		isProviderStatusReady,
		selectedProviderModel,
		setFutureProviderModelSelection,
		thinkingLevel,
		unavailableCommandCapabilities,
	};
};
