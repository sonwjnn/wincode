import type { CommandHandlerMap } from "@/modules/commands/execute-command";
import { CONNECTION_DIALOG_WIDTH } from "@/modules/connections";
import { SessionsDialogContent } from "@/modules/sessions/ui/dialogs/sessions-dialog";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";

type SessionHandlerDependencies = {
	dialog: Pick<DialogContextValue, "open">;
	navigateHome: () => void;
	onCompact?: (focus?: string) => boolean | Promise<boolean>;
};

export const createSessionHandlers = ({
	dialog,
	navigateHome,
	onCompact,
}: SessionHandlerDependencies): Pick<
	CommandHandlerMap,
	"session.new" | "session.compact" | "dialog.sessions"
> => ({
	"session.new": navigateHome,
	"session.compact": (focus) => {
		if (!onCompact) {
			throw new Error("Compaction is unavailable in this view.");
		}
		return onCompact(focus);
	},
	"dialog.sessions": () => {
		dialog.open({
			children: <SessionsDialogContent />,
			padding: { bottom: 1, right: 0, top: 1, left: 0 },
			titleMargin: { left: 4, right: 4 },
			title: "Sessions",
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
});
