import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	type ModelVariant,
	normalizeModelVariant,
} from "@wincode/ai/models";
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
	variant: ModelVariant | undefined;
};

export type PromptConfig = PromptConfigState & {
	cycleAgent: (selectableAgents: readonly { id: AgentId }[]) => void;
	setAgent: (agent: AgentId) => void;
	setModel: (model: ChatModelSelection) => void;
	setVariant: (variant: ModelVariant | undefined) => void;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

export const updatePromptConfigModel = (
	current: PromptConfigState,
	nextModel: ChatModelSelection
): PromptConfigState => {
	if (
		current.model.modelId === nextModel.modelId &&
		current.model.providerId === nextModel.providerId
	) {
		return { ...current, model: nextModel };
	}

	return { ...current, model: nextModel, variant: undefined };
};

type PromptConfigProviderProps = {
	children: ReactNode;
	initialAgent?: AgentId;
	initialModel?: ChatModelSelection;
	initialVariant?: ModelVariant;
};
export function PromptConfigProvider({
	children,
	initialAgent = buildAgent.id,
	initialModel = defaultChatModelSelection,
	initialVariant = "low",
}: PromptConfigProviderProps) {
	const registry = useAgentRegistry();
	const hasExplicitAgent = useRef(initialAgent !== buildAgent.id);
	const [config, setConfig] = useState<PromptConfigState>({
		agent: initialAgent,
		model: initialModel,
		variant: normalizeModelVariant(initialModel, initialVariant),
	});

	useEffect(() => {
		if (registry === null || hasExplicitAgent.current) {
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
				return next === undefined ? current : { ...current, agent: next.id };
			});
		},
		[]
	);

	const setAgent = useCallback((agent: AgentId) => {
		hasExplicitAgent.current = true;
		setConfig((current) => ({ ...current, agent }));
	}, []);

	const setModel = useCallback((model: ChatModelSelection) => {
		setConfig((current) => updatePromptConfigModel(current, model));
	}, []);

	const setVariant = useCallback((variant: ModelVariant | undefined) => {
		setConfig((current) => ({
			...current,
			variant: normalizeModelVariant(current.model, variant),
		}));
	}, []);

	return (
		<PromptConfigContext.Provider
			value={{
				agent: config.agent,
				cycleAgent,
				model: config.model,
				setAgent,
				setModel,
				setVariant,
				variant: config.variant,
			}}
		>
			{children}
		</PromptConfigContext.Provider>
	);
}

export function usePromptConfig(): PromptConfig {
	const context = useContext(PromptConfigContext);

	if (context === null) {
		throw new Error(
			"usePromptConfig must be used within a PromptConfigProvider"
		);
	}

	return context;
}
