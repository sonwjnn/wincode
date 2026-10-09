import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	getSupportedThinkingLevels,
	normalizeThinkingSelection,
	type ThinkingLevel,
	type ThinkingSelection,
} from "@wincode/ai/models";
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
	buildAgent,
	resolveActiveAgentId,
	useAgentRegistry,
} from "@/modules/agents";

type PromptConfigState = {
	agent: AgentId;
	model: ChatModelSelection;
} & ThinkingSelection;
export type PromptConfig = PromptConfigState & {
	cycleThinkingLevel: () => void;
	setAgent: (agent: AgentId) => void;
	setModel: (model: ChatModelSelection) => void;
	setThinkingLevel: (thinkingLevel: ThinkingLevel | undefined) => void;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

export const resolveInitialPromptThinkingSelection = (
	model: ChatModelSelection,
	initialThinkingLevel: ThinkingLevel | undefined
): ThinkingSelection =>
	normalizeThinkingSelection(model, {
		thinkingLevel: initialThinkingLevel ?? "low",
	});

export const updatePromptConfigModel = (
	current: PromptConfigState,
	nextModel: ChatModelSelection
): PromptConfigState => ({
	agent: current.agent,
	model: nextModel,
	...normalizeThinkingSelection(nextModel, current),
});

export const updatePromptConfigSelection = (
	current: PromptConfigState,
	selection: ThinkingSelection
): PromptConfigState => ({
	agent: current.agent,
	model: current.model,
	...normalizeThinkingSelection(current.model, selection),
});

type InitialThinkingSelection = Readonly<{
	initialThinkingLevel?: ThinkingLevel;
}>;

type PromptConfigProviderProps = {
	children: ReactNode;
	initialAgent?: AgentId;
	initialModel?: ChatModelSelection;
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

	useEffect(() => {
		if (isNull(registry) || hasExplicitAgent.current) {
			return;
		}
		setConfig((current) => ({
			...current,
			agent: resolveActiveAgentId(registry),
		}));
	}, [registry]);

	const cycleThinkingLevel = useCallback(() => {
		setConfig((current) => {
			const options: (ThinkingLevel | undefined)[] = [
				undefined,
				...getSupportedThinkingLevels(current.model),
			];
			const currentIndex = options.indexOf(current.thinkingLevel);
			const next = options[(currentIndex + 1) % options.length];
			return updatePromptConfigSelection(
				current,
				next === undefined ? {} : { thinkingLevel: next }
			);
		});
	}, []);

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

	const setModel = useCallback((model: ChatModelSelection) => {
		setConfig((current) => updatePromptConfigModel(current, model));
	}, []);

	return (
		<PromptConfigContext.Provider
			value={{
				...config,
				cycleThinkingLevel,
				setAgent,
				setModel,
				setThinkingLevel,
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
