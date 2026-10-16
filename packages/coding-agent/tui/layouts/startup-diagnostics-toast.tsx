import { useEffect } from "react";
import { useToast } from "@/shared/providers/toast/toast-provider";

export type StartupDiagnosticsToastProps = Readonly<{
	messages: readonly string[];
}>;

export function StartupDiagnosticsToast({
	messages,
}: StartupDiagnosticsToastProps) {
	const toast = useToast();
	const message = messages.join("\n");

	useEffect(() => {
		if (message.length === 0) {
			return;
		}
		toast.show({ message, variant: "info", duration: 15_000, width: 80 });
	}, [message, toast]);

	return null;
}
