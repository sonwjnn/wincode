import { CONNECTION_DIALOG_WIDTH } from "@/modules/connections";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { DialogConfig } from "@/shared/providers/dialog/types";

type CommandDialogMetadata = Pick<DialogConfig, "children" | "title">;

/** Shared presentation for dialogs opened by slash commands. */
export function openCommandDialog(
	dialog: Pick<DialogContextValue, "open">,
	metadata: CommandDialogMetadata
): void {
	dialog.open({
		padding: { bottom: 1, left: 0, right: 0, top: 1 },
		titleMargin: { left: 4, right: 4 },
		width: CONNECTION_DIALOG_WIDTH,
		...metadata,
	});
}
