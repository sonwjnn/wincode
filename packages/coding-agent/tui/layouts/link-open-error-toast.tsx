import { useEffect } from "react";
import { subscribeLinkOpenFailures } from "@/shared/links/open-external-link";
import { useToast } from "@/shared/providers/toast/toast-provider";

export function LinkOpenErrorToast() {
	const { show } = useToast();

	useEffect(
		() =>
			subscribeLinkOpenFailures(() => {
				show({ message: "Failed to open link.", variant: "error" });
			}),
		[show]
	);

	return null;
}
