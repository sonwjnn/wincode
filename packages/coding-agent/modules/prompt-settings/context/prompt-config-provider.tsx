import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	type Effort,
	getSupportedModelEfforts,
	getSupportedReasoningModes,
	normalizeReasoningSelection,
	type ReasoningMode,
	type ReasoningSelection,
} from "@wincode/ai/models";
import { isNull, isUndefined } from "@wincode/runtime-utils";
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
	buildAgent,
	resolveActiveAgentId,
	useAgentRegistry,
} from "@/modules/agents";

type PromptConfigState = {
	agent: AgentId;
	model: ChatModelSelection;
} & ReasoningSelection;
export type PromptConfig = PromptConfigState & {
	cycleAgent: (selectableAgents: readonly { id: AgentId }[]) => void;
	cycleReasoningChoice: () => void;
	setAgent: (agent: AgentId) => void;
	setEffort: (effort: Effort | undefined) => void;
	setModel: (model: ChatModelSelection) => void;
	setReasoningMode: (reasoningMode: ReasoningMode | undefined) => void;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

export const resolveInitialPromptReasoningSelection = (
	model: ChatModelSelection,
	initialEffort: Effort | undefined,
	initialReasoningMode: ReasoningMode | undefined
): ReasoningSelection =>
	normalizeReasoningSelection(
		model,
		initialReasoningMode === undefined
			? { effort: initialEffort ?? "low" }
			: { reasoningMode: initialReasoningMode }
	);

export const updatePromptConfigModel = (
	current: PromptConfigState,
	nextModel: ChatModelSelection
): PromptConfigState => ({
	agent: current.agent,
	model: nextModel,
	...normalizeReasoningSelection(nextModel, current),
});

export const updatePromptConfigSelection = (
	current: PromptConfigState,
	selection: ReasoningSelection
): PromptConfigState => ({
	agent: current.agent,
	model: current.model,
	...normalizeReasoningSelection(current.model, selection),
});

type InitialReasoningSelection =
	| {
			initialEffort?: Effort;
			initialReasoningMode?: never;
	  }
	| {
			initialEffort?: never;
			initialReasoningMode?: ReasoningMode;
	  };

type PromptConfigProviderProps = {
	children: ReactNode;
	initialAgent?: AgentId;
	initialModel?: ChatModelSelection;
} & InitialReasoningSelection;
export function PromptConfigProvider({
	children,
	initialAgent = buildAgent.id,
	initialModel = defaultChatModelSelection,
	initialEffort,
	initialReasoningMode,
}: PromptConfigProviderProps) {
	const registry = useAgentRegistry();
	const hasExplicitAgent = useRef(initialAgent !== buildAgent.id);
	const [config, setConfig] = useState<PromptConfigState>(() => ({
		agent: initialAgent,
		model: initialModel,
		...resolveInitialPromptReasoningSelection(
			initialModel,
			initialEffort,
			initialReasoningMode
		),
	}));

	useEffect(() => {
		if (isNull(registry) || hasExplicitAgent.current) {
			return;
		}
		setConfig((current) => ({
			...current,
			agent: resolveActiveAgentId(registry),
		}));
	}, [registry]);

	const cycleAgent = useCallback(
		(selectableAgents: readonly { id: AgentId }[]) => {
			hasExplicitAgent.current = true;
			setConfig((current) => {
				if (selectableAgents.length === 0) {
					return current;
				}

				const currentIndex = selectableAgents.findIndex(
					({ id }) => id === current.agent
				);
				const next =
					selectableAgents[(currentIndex + 1) % selectableAgents.length];
				return isUndefined(next) ? current : { ...current, agent: next.id };
			});
		},
		[]
	);

	const cycleReasoningChoice = useCallback(() => {
		setConfig((current) => {
			const options: ReasoningSelection[] = [
				{},
				...getSupportedReasoningModes(current.model).map((reasoningMode) => ({
					reasoningMode,
				})),
				...getSupportedModelEfforts(current.model).map((effort) => ({
					effort,
				})),
			];
			const currentIndex = options.findIndex(
				(option) =>
					option.effort === current.effort &&
					option.reasoningMode === current.reasoningMode
			);
			const next = options[(currentIndex + 1) % options.length] ?? {};
			return updatePromptConfigSelection(current, next);
		});
	}, []);

	const setAgent = useCallback((agent: AgentId) => {
		hasExplicitAgent.current = true;
		setConfig((current) => ({ ...current, agent }));
	}, []);

	const setEffort = useCallback((effort: Effort | undefined) => {
		setConfig((current) =>
			updatePromptConfigSelection(
				current,
				effort === undefined ? {} : { effort }
			)
		);
	}, []);

	const setModel = useCallback((model: ChatModelSelection) => {
		setConfig((current) => updatePromptConfigModel(current, model));
	}, []);

	const setReasoningMode = useCallback(
		(reasoningMode: ReasoningMode | undefined) => {
			setConfig((current) =>
				updatePromptConfigSelection(
					current,
					reasoningMode === undefined ? {} : { reasoningMode }
				)
			);
		},
		[]
	);

	return (
		<PromptConfigContext.Provider
			value={{
				cycleAgent,
				...config,
				cycleReasoningChoice,
				setAgent,
				setEffort,
				setModel,
				setReasoningMode,
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
