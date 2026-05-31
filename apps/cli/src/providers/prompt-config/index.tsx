import {
	defaultChatModel,
	defaultMode,
	getNextCodingModeName,
	type ModeType,
	type SupportedChatModelId,
} from "@wincode/ai";
import { createContext, type ReactNode, useContext, useState } from "react";

type PromptConfig = {
	cycleMode: () => void;
	mode: ModeType;
	model: SupportedChatModelId;
	setModel: (model: SupportedChatModelId) => void;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

type PromptConfigProviderProps = {
	children: ReactNode;
	initialMode?: ModeType;
	initialModel?: SupportedChatModelId;
};
export function PromptConfigProvider({
	children,
	initialMode = defaultMode.value,
	initialModel = defaultChatModel.value,
}: PromptConfigProviderProps) {
	const [mode, setModeName] = useState<ModeType>(initialMode);
	const [model, setModel] = useState<SupportedChatModelId>(initialModel);

	const cycleMode = () => {
		setModeName((currentModeName) => getNextCodingModeName(currentModeName));
	};

	return (
		<PromptConfigContext.Provider value={{ cycleMode, mode, model, setModel }}>
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
