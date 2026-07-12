import {
	type ChatModelSelection,
	defaultChatModelSelection,
	defaultMode,
	getNextCodingModeName,
	type ModeType,
} from "@wincode/ai";
import { createContext, type ReactNode, useContext, useState } from "react";

type PromptConfig = {
	cycleMode: () => void;
	mode: ModeType;
	model: ChatModelSelection;
	setMode: (mode: ModeType) => void;
	setModel: (model: ChatModelSelection) => void;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

type PromptConfigProviderProps = {
	children: ReactNode;
	initialMode?: ModeType;
	initialModel?: ChatModelSelection;
};
export function PromptConfigProvider({
	children,
	initialMode = defaultMode.value,
	initialModel = defaultChatModelSelection,
}: PromptConfigProviderProps) {
	const [mode, setModeName] = useState<ModeType>(initialMode);
	const [model, setModel] = useState<ChatModelSelection>(initialModel);

	const cycleMode = () => {
		setModeName((currentModeName) => getNextCodingModeName(currentModeName));
	};

	return (
		<PromptConfigContext.Provider
			value={{ cycleMode, mode, model, setMode: setModeName, setModel }}
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
