import type { ReactNode } from "react";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import {
	CopyOnSelectSettingsProvider,
	HideThinkingSettingsProvider,
} from "@/modules/settings";

export function SettingsProviders({ children }: { children: ReactNode }) {
	return (
		<PromptConfigProvider>
			<CopyOnSelectSettingsProvider>
				<HideThinkingSettingsProvider>{children}</HideThinkingSettingsProvider>
			</CopyOnSelectSettingsProvider>
		</PromptConfigProvider>
	);
}
