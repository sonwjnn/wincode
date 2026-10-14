import type { AgentId } from "@wincode/agent-core";
import {
	defaultChatModelSelection,
	getSupportedThinkingLevels,
	type ThinkingLevel,
	type ThinkingSelection,
} from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
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
	catalogSelectionForProviderModel,
	normalizeProviderThinkingSelection,
	type ProviderModelSelection,
	supportedProviderThinkingLevels,
} from "@/modules/providers/provider-model-selection";

type PromptConfigState = {
	agent: AgentId;
	model: ProviderModelSelection;
} & ThinkingSelection;
export type PromptConfig = PromptConfigState & {
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
	model: ProviderModelSelection,
	initialThinkingLevel: ThinkingLevel | undefined
): ThinkingSelection =>
	normalizeProviderThinkingSelection(model, {
		thinkingLevel: initialThinkingLevel ?? "low",
	});

export const updatePromptConfigModel = (
	current: PromptConfigState,
	nextModel: ProviderModelSelection
): PromptConfigState => ({
	agent: current.agent,
	model: nextModel,
	...normalizeProviderThinkingSelection(nextModel, current),
});

export const updatePromptConfigSelection = (
	current: PromptConfigState,
	selection: ThinkingSelection
): PromptConfigState => ({
	agent: current.agent,
	model: current.model,
	...normalizeProviderThinkingSelection(current.model, selection),
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
	initialModel = defaultChatModelSelection,
	initialThinkingLevel,
}: PromptConfigProviderProps) {
	const registry = useAgentRegistry();
	const hasExplicitAgent = useRef(initialAgent !== buildAgent.id);
	const [config, setConfig] = useState<PromptConfigState>(() => ({
		agent: initialAgent,
		model: initialModel,
		...resolveInitialPromptThinkingSelection(
			initialModel,
			initialThinkingLevel
		),
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
			const catalogModel = catalogSelectionForProviderModel(config.model);
			let levels: readonly ThinkingLevel[];
			if (providerModel !== undefined) {
				levels = supportedProviderThinkingLevels(providerModel);
			} else if (catalogModel === null) {
				levels = [];
			} else {
				levels = getSupportedThinkingLevels(catalogModel);
			}
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
		[config.model, config.thinkingLevel]
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
