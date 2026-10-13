import { useCallback } from "react";
import { ConnectionApiKeyDialogContent } from "@/modules/connections/ui/connection-api-key-dialog";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";

const openRouterSdkProvider = {
	displayName: "OpenRouter Provider SDK",
	methods: ["api-key"] as const,
};

type Props = Readonly<{
	controller: InteractiveProviderController;
}>;

/** Saves only to Provider SDK storage and refreshes Known Models after connect. */
export const ProviderSdkConnectDialogContent = ({ controller }: Props) => {
	const dialog = useDialog();
	const { show } = useToast();
	const submit = useCallback(
		async (apiKey: string, signal: AbortSignal) => {
			await controller.connectOpenRouterApiKey(apiKey, { signal });
			if (signal.aborted) {
				return;
			}
			dialog.close();
			show({
				message: "OpenRouter Provider connected and Known Models refreshed.",
				variant: "success",
			});
		},
		[controller, dialog, show]
	);
	return (
		<ConnectionApiKeyDialogContent
			onSubmit={submit}
			placeholder="Paste OpenRouter API key"
			provider={openRouterSdkProvider}
		/>
	);
};
