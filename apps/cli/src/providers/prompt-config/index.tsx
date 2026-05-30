import {
	type CodingAgentModeName,
	defaultCodingMode,
	getNextCodingModeName,
} from "@wincode/ai";
import { createContext, type ReactNode, useContext, useState } from "react";

type PromptConfig = {
	cycleMode: () => void;
	modeName: CodingAgentModeName;
};

const PromptConfigContext = createContext<PromptConfig | null>(null);

type PromptConfigProviderProps = {
	children: ReactNode;
	initialMode?: CodingAgentModeName;
};

export function PromptConfigProvider({
	children,
	initialMode = defaultCodingMode.name,
}: PromptConfigProviderProps) {
	const [modeName, setModeName] = useState<CodingAgentModeName>(initialMode);

	const cycleMode = () => {
		setModeName((currentModeName) => getNextCodingModeName(currentModeName));
	};

	return (
		<PromptConfigContext.Provider value={{ cycleMode, modeName }}>
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
