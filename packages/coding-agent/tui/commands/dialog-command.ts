import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { DialogConfig } from "@/shared/providers/dialog/types";

type CommandDialogMetadata = Pick<DialogConfig, "children" | "title">;

const COMMAND_DIALOG_WIDTH = 60;

/** Shared presentation for dialogs opened by slash commands. */
export function openCommandDialog(
	dialog: Pick<DialogContextValue, "open">,
	metadata: CommandDialogMetadata
): void {
	dialog.open({
		width: COMMAND_DIALOG_WIDTH,
		...metadata,
	});
}
