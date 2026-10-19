import type { AgentId } from "@wincode/agent-core";
import type {
	ProviderModel,
	ThinkingLevel,
	ThinkingSelection,
} from "@wincode/ai";
import { isNull } from "@wincode/utils";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type AgentSelectionOverride,
	buildAgent,
	resolveActiveAgentId,
	useAgentRegistry,
} from "@/modules/agents";
import {
	clampProviderModelThinkingSelection,
	DEFAULT_PROVIDER_MODEL_SELECTION,
	isSameProviderModelSelection,
	normalizeProviderModelThinkingSelection,
	type ProviderModelSelection,
	supportedProviderThinkingLevels,
} from "@/modules/providers/provider-model-selection";

type PromptConfigState = {
	agent: AgentId;
	model: ProviderModelSelection;
} & ThinkingSelection;
export type PromptConfig = PromptConfigState & {
	isAgentSelectionReady: boolean;
	cycleThinkingLevel: (providerModel?: ProviderModel) => void;
	setAgent: (agent: AgentId) => void;
	setModel: (model: ProviderModelSelection) => void;
	setModelForFutureSubmissions: (
		providerModel: ProviderModel,
		selection: ProviderModelSelection
	) => void;
	setThinkingLevel: (thinkingLevel: ThinkingLevel | undefined) => void;
	setThinkingLevelForFutureSubmissions: (
		thinkingLevel: ThinkingLevel | undefined
	) => void;
	submissionSelectionOverride: AgentSelectionOverride;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

export const resolveInitialPromptThinkingSelection = (
	initialThinkingLevel: ThinkingLevel | undefined
): ThinkingSelection =>
	initialThinkingLevel === undefined
		? {}
		: { thinkingLevel: initialThinkingLevel };

export const nextThinkingLevelInCycle = (
	currentLevel: ThinkingLevel | undefined,
	levels: readonly ThinkingLevel[]
): ThinkingLevel | undefined => {
	if (levels.length === 0) {
		return;
	}
	const currentIndex =
		currentLevel === undefined ? -1 : levels.indexOf(currentLevel);
	return levels[(currentIndex + 1) % levels.length];
};

export const updatePromptConfigModel = (
	current: PromptConfigState,
	nextModel: ProviderModelSelection,
	providerModel: ProviderModel
): PromptConfigState => ({
	agent: current.agent,
	model: nextModel,
	...(isSameProviderModelSelection(current.model, nextModel)
		? normalizeProviderModelThinkingSelection(providerModel, current)
		: clampProviderModelThinkingSelection(providerModel, "low")),
});

export const updatePromptConfigModelOverride = (
	current: AgentSelectionOverride,
	currentModel: ProviderModelSelection,
	nextModel: ProviderModelSelection,
	providerModel: ProviderModel
): AgentSelectionOverride => {
	let thinking: ThinkingSelection | undefined;
	if (isSameProviderModelSelection(currentModel, nextModel)) {
		if (current.thinking !== undefined) {
			thinking = normalizeProviderModelThinkingSelection(
				providerModel,
				current.thinking
			);
		}
	} else {
		thinking = clampProviderModelThinkingSelection(providerModel, "low");
	}
	return {
		...current,
		model: nextModel,
		...(thinking === undefined ? {} : { thinking }),
	};
};

export const updatePromptConfigSelection = (
	current: PromptConfigState,
	selection: ThinkingSelection
): PromptConfigState => ({
	agent: current.agent,
	model: current.model,
	...selection,
});

type InitialThinkingSelection = Readonly<{
	initialThinkingLevel?: ThinkingLevel;
}>;

type PromptConfigProviderProps = {
	children: ReactNode;
	initialAgent?: AgentId;
	initialModel?: ProviderModelSelection;
} & InitialThinkingSelection;
export function PromptConfigProvider({
	children,
	initialAgent = buildAgent.id,
	initialModel = DEFAULT_PROVIDER_MODEL_SELECTION,
	initialThinkingLevel,
}: PromptConfigProviderProps) {
	const registry = useAgentRegistry();
	const hasExplicitAgent = useRef(initialAgent !== buildAgent.id);
	const [config, setConfig] = useState<PromptConfigState>(() => ({
		agent: initialAgent,
		model: initialModel,
		...resolveInitialPromptThinkingSelection(initialThinkingLevel),
	}));
	const [submissionSelectionOverride, setSubmissionSelectionOverride] =
		useState<AgentSelectionOverride>({});
	const modelSelectionRef = useRef(initialModel);

	useEffect(() => {
		if (isNull(registry) || hasExplicitAgent.current) {
			return;
		}
		setConfig((current) => ({
			...current,
			agent: resolveActiveAgentId(registry),
		}));
	}, [registry]);

	const cycleThinkingLevel = useCallback(
		(providerModel?: ProviderModel) => {
			const levels =
				providerModel === undefined
					? []
					: supportedProviderThinkingLevels(providerModel);
			const next = nextThinkingLevelInCycle(config.thinkingLevel, levels);
			if (next === undefined) {
				return;
			}
			const selection = { thinkingLevel: next };
			setConfig((current) => updatePromptConfigSelection(current, selection));
			setSubmissionSelectionOverride((current) => ({
				...current,
				thinking: selection,
			}));
		},
		[config.thinkingLevel]
	);

	const setAgent = useCallback((agent: AgentId) => {
		hasExplicitAgent.current = true;
		setConfig((current) => ({ ...current, agent }));
	}, []);

	const setThinkingLevel = useCallback(
		(thinkingLevel: ThinkingLevel | undefined) => {
			setConfig((current) =>
				updatePromptConfigSelection(
					current,
					thinkingLevel === undefined ? {} : { thinkingLevel }
				)
			);
		},
		[]
	);

	const setModel = useCallback((model: ProviderModelSelection) => {
		modelSelectionRef.current = model;
		setConfig((current) => ({ ...current, model }));
	}, []);

	const setModelForFutureSubmissions = useCallback(
		(providerModel: ProviderModel, selection: ProviderModelSelection) => {
			const currentModel = modelSelectionRef.current;
			modelSelectionRef.current = selection;
			setConfig((current) =>
				updatePromptConfigModel(current, selection, providerModel)
			);
			setSubmissionSelectionOverride((current) =>
				updatePromptConfigModelOverride(
					current,
					currentModel,
					selection,
					providerModel
				)
			);
		},
		[]
	);

	const setThinkingLevelForFutureSubmissions = useCallback(
		(thinkingLevel: ThinkingLevel | undefined) => {
			setThinkingLevel(thinkingLevel);
			setSubmissionSelectionOverride((current) => ({
				...current,
				thinking: thinkingLevel === undefined ? {} : { thinkingLevel },
			}));
		},
		[setThinkingLevel]
	);

	return (
		<PromptConfigContext.Provider
			value={{
				...config,
				isAgentSelectionReady:
					!isNull(registry) &&
					(hasExplicitAgent.current ||
						config.agent === registry.defaultAgentId),
				cycleThinkingLevel,
				setAgent,
				setModel,
				setModelForFutureSubmissions,
				setThinkingLevel,
				setThinkingLevelForFutureSubmissions,
				submissionSelectionOverride,
			}}
		>
			{children}
		</PromptConfigContext.Provider>
	);
}

export function usePromptConfig(): PromptConfig {
	const context = useContext(PromptConfigContext);

	if (isNull(context)) {
		throw new Error(
			"usePromptConfig must be used within a PromptConfigProvider"
		);
	}

	return context;
}
