import type { ModelVariant } from "@wincode/ai";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	defaultMode,
	getNextCodingModeName,
	type ModeType,
	normalizeModelVariant,
} from "@wincode/ai";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";

type PromptConfigState = {
	mode: ModeType;
	model: ChatModelSelection;
	variant: ModelVariant | undefined;
};

export type PromptConfig = PromptConfigState & {
	cycleMode: () => void;
	setMode: (mode: ModeType) => void;
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
	initialMode?: ModeType;
	initialModel?: ChatModelSelection;
	initialVariant?: ModelVariant;
};
export function PromptConfigProvider({
	children,
	initialMode = defaultMode.value,
	initialModel = defaultChatModelSelection,
	initialVariant,
}: PromptConfigProviderProps) {
	const [config, setConfig] = useState<PromptConfigState>({
		mode: initialMode,
		model: initialModel,
		variant: normalizeModelVariant(initialModel, initialVariant),
	});

	const cycleMode = useCallback(() => {
		setConfig((current) => ({
			...current,
			mode: getNextCodingModeName(current.mode),
		}));
	}, []);

	const setMode = useCallback((mode: ModeType) => {
		setConfig((current) => ({ ...current, mode }));
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
				cycleMode,
				mode: config.mode,
				model: config.model,
				setMode,
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
