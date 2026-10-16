import type { AgentId } from "@wincode/agent-core";
import type {
	ProviderModel,
	ThinkingLevel,
	ThinkingSelection,
} from "@wincode/ai/sdk";
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
	DEFAULT_PROVIDER_MODEL_SELECTION,
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
	setModelForFutureSubmissions: (model: ProviderModelSelection) => void;
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

export const updatePromptConfigModel = (
	current: PromptConfigState,
	nextModel: ProviderModelSelection
): PromptConfigState => ({ ...current, model: nextModel });

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
			const options: (ThinkingLevel | undefined)[] = [undefined, ...levels];
			const currentIndex = options.indexOf(config.thinkingLevel);
			const next = options[(currentIndex + 1) % options.length];
			const selection = next === undefined ? {} : { thinkingLevel: next };
			setConfig((current) => updatePromptConfigSelection(current, selection));
			setSubmissionSelectionOverride((current) =>
				current.thinking === undefined
					? current
					: { ...current, thinking: selection }
			);
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
		setConfig((current) => updatePromptConfigModel(current, model));
	}, []);

	const setModelForFutureSubmissions = useCallback(
		(model: ProviderModelSelection) => {
			setModel(model);
			setSubmissionSelectionOverride((current) => ({ ...current, model }));
		},
		[setModel]
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
