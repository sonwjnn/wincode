import type { CliRenderer } from "@opentui/core";
import type { Connections } from "@wincode/ai/connections";
import open from "open";
import { createElement } from "react";
import type { CommandHandlerMap } from "@/modules/commands/execute-command";
import {
	CONNECTION_DIALOG_WIDTH,
	ConnectDialogContent,
} from "@/modules/connections";
import { McpStatusDialogContent } from "@/modules/mcp";
import { ThemeDialogContent } from "@/modules/prompt-settings/ui/theme-dialog";
import {
	type ClipboardSpawn,
	writeClipboard,
} from "@/shared/clipboard/clipboard";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { ToastContextValue } from "@/shared/providers/toast/toast-provider";

export async function copyBrowserAuthorizationUrl(
	renderer: Pick<CliRenderer, "copyToClipboardOSC52">,
	url: string,
	spawnProcess?: ClipboardSpawn
): Promise<void> {
	if (await writeClipboard(renderer, url, spawnProcess)) {
		return;
	}
	if (process.platform !== "darwin") {
		throw new Error("Clipboard is not supported by this terminal.");
	}
	throw new Error("Failed to copy URL.");
}

type AppHandlerDependencies = {
	connections: Pick<Connections, "listProviders">;
	dialog: Pick<DialogContextValue, "open">;
	onOpenSettings?: (section?: string) => void | Promise<void>;
	refreshAgentRegistry: () => void;
	renderer: Pick<CliRenderer, "copyToClipboardOSC52" | "destroy">;
	toast: Pick<ToastContextValue, "show">;
};

export const createAppHandlers = ({
	connections,
	dialog,
	onOpenSettings,
	refreshAgentRegistry,
	renderer,
	toast,
}: AppHandlerDependencies): Pick<
	CommandHandlerMap,
	| "app.exit"
	| "connection.open"
	| "dialog.mcps"
	| "dialog.theme"
	| "settings.open"
> => ({
	"app.exit": () => renderer.destroy(),
	"settings.open": () => {
		if (!onOpenSettings) {
			throw new Error("Settings are unavailable in this view.");
		}
		return onOpenSettings();
	},
	"dialog.theme": () => {
		dialog.open({
			children: <ThemeDialogContent />,
			padding: { bottom: 1, left: 0, right: 0, top: 1 },
			title: "Select Theme",
			titleMargin: { left: 4, right: 4 },
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
	"dialog.mcps": () => {
		dialog.open({
			children: <McpStatusDialogContent />,
			padding: { bottom: 1, left: 0, right: 0, top: 1 },
			title: "MCPs",
			titleMargin: { left: 4, right: 4 },
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
	"connection.open": async () => {
		const connectedProviders = await connections.listProviders();
		dialog.open({
			children: createElement(ConnectDialogContent, {
				connectedProviders,
				onBrowserCopyUrl: async (url: string) => {
					await copyBrowserAuthorizationUrl(renderer, url);
					toast.show({
						message: "Authorization URL copied.",
						variant: "success",
					});
				},
				onBrowserOpenUrl: async (url: string) => {
					await open(url);
				},
				onConnected: (summary) => {
					refreshAgentRegistry();
					toast.show({
						message: `${summary.displayName} connected.`,
						variant: "success",
					});
				},
			}),
			padding: { bottom: 1, left: 0, right: 0, top: 1 },
			title: "Connect",
			titleMargin: { left: 4, right: 4 },
			width: CONNECTION_DIALOG_WIDTH,
		});
	},
});
