import type { ReactNode } from "react";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { SettingsRegistryProvider } from "@/modules/settings";

export function SettingsProviders({ children }: { children: ReactNode }) {
	return (
		<PromptConfigProvider>
			<SettingsRegistryProvider>{children}</SettingsRegistryProvider>
		</PromptConfigProvider>
	);
}
