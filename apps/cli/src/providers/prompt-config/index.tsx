import { defaultMode, getNextCodingModeName, type ModeType } from "@wincode/ai";
import { createContext, type ReactNode, useContext, useState } from "react";

type PromptConfig = {
	cycleMode: () => void;
	mode: ModeType;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

type PromptConfigProviderProps = {
	children: ReactNode;
	initialMode?: ModeType;
};

export function PromptConfigProvider({
	children,
	initialMode = defaultMode.value,
}: PromptConfigProviderProps) {
	const [mode, setModeName] = useState<ModeType>(initialMode);

	const cycleMode = () => {
		setModeName((currentModeName) => getNextCodingModeName(currentModeName));
	};

	return (
		<PromptConfigContext.Provider value={{ cycleMode, mode }}>
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
