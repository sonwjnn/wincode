import type { ReactNode } from "react";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { CopyOnSelectSettingsProvider } from "@/modules/settings";

export function SettingsProviders({ children }: { children: ReactNode }) {
	return (
		<PromptConfigProvider>
			<CopyOnSelectSettingsProvider>{children}</CopyOnSelectSettingsProvider>
		</PromptConfigProvider>
	);
}
