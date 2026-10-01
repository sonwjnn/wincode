import type { CliRenderer } from "@opentui/core";
import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	modelCatalog,
} from "@wincode/ai/models";
import open from "open";
import { createElement, type ReactNode } from "react";
import {
	COMMANDS,
	type CommandActionId,
	type CommandDefinitionFor,
} from "@/modules/commands/commands";
import type { CommandHandlerMap } from "@/modules/commands/execute-command";
import { ConnectDialogContent } from "@/modules/connections";
import { McpStatusDialogContent } from "@/modules/mcp";
import type { PromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import { EffortDialogContent } from "@/modules/prompt-settings/ui/effort-dialog";
import { getModelsForPicker } from "@/modules/prompt-settings/ui/model-picker-options";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import { ThemeDialogContent } from "@/modules/prompt-settings/ui/theme-dialog";
import { SessionsDialogContent } from "@/modules/sessions/ui/dialogs/sessions-dialog";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { ToastContextValue } from "@/shared/providers/toast/toast-provider";
import { copyBrowserAuthorizationUrl } from "./browser-authorization";
import { openCommandDialog } from "./dialog-command";

export type CommandStrategyContext = {
	config: PromptConfig;
	connections: Pick<Connections, "listProviders">;
	dialog: Pick<DialogContextValue, "open">;
	getRecentModelSelections: (limit: number) => ChatModelSelection[];
	navigateHome: () => void;
	onCompact?: (focus?: string) => boolean | Promise<boolean>;
	onOpenSettings?: (section?: string) => void | Promise<void>;
	refreshAgentRegistry: () => void;
	renderer: Pick<CliRenderer, "copyToClipboardOSC52" | "destroy">;
	toast: Pick<ToastContextValue, "show">;
};

type StrategyArguments<Action extends CommandActionId> =
	CommandDefinitionFor<Action>["input"] extends { kind: "optional-text" }
		? [argument?: string]
		: [];

type CommandStrategy<Action extends CommandActionId> =
	| {
			kind: "dialog";
			title: string;
			content: (
				context: CommandStrategyContext,
				...args: StrategyArguments<Action>
			) => ReactNode;
	  }
	| {
			kind: "prepared-dialog";
			title: string;
			content: (
				context: CommandStrategyContext,
				...args: StrategyArguments<Action>
			) => Promise<ReactNode>;
	  }
	| {
			kind: "action";
			run: (
				context: CommandStrategyContext,
				...args: StrategyArguments<Action>
			) => unknown;
	  };

type RuntimeStrategy =
	| {
			kind: "dialog";
			title: string;
			content: (
				context: CommandStrategyContext,
				argument?: string
			) => ReactNode;
	  }
	| {
			kind: "prepared-dialog";
			title: string;
			content: (
				context: CommandStrategyContext,
				argument?: string
			) => Promise<ReactNode>;
	  }
	| {
			kind: "action";
			run: (context: CommandStrategyContext, argument?: string) => unknown;
	  };

/** Each built-in action has one execution strategy; the map is exhaustive. */
const STRATEGIES = {
	"session.new": {
		kind: "action",
		run: ({ navigateHome }) => navigateHome(),
	},
	"session.compact": {
		kind: "action",
		run: ({ onCompact }, focus) => {
			if (!onCompact) {
				throw new Error("Compaction is unavailable in this view.");
			}
			return onCompact(focus);
		},
	},
	"settings.open": {
		kind: "action",
		run: ({ onOpenSettings }) => {
			if (!onOpenSettings) {
				throw new Error("Settings are unavailable in this view.");
			}
			return onOpenSettings();
		},
	},
	"agent.select": {
		kind: "prepared-dialog",
		title: "Select Agent",
		content: async ({ config, connections }) => {
			const providers = await connections.listProviders();
			return createElement(AgentsDialogContent, {
				connectedProviderIds: new Set(
					providers.filter(({ connected }) => connected).map(({ id }) => id)
				),
				currentAgent: config.agent,
				onSelectAgent: config.setAgent,
			});
		},
	},
	"model.select": {
		kind: "dialog",
		title: "Select Model",
		content: ({ config, getRecentModelSelections }) =>
			createElement(ModelsDialogContent, {
				currentModel: config.model,
				models: getModelsForPicker(modelCatalog, config.model),
				onSelectModel: config.setModel,
				recentSelections: getRecentModelSelections(10),
			}),
	},
	"effort.select": {
		kind: "dialog",
		title: "Select Effort",
		content: ({ config }) => {
			const supportedModel = findSupportedChatModelSelection(config.model);
			if (!supportedModel) {
				throw new Error("Effort selection is unavailable in this view.");
			}
			return createElement(EffortDialogContent, {
				currentEffort: config.effort,
				currentModel: supportedModel,
				currentReasoningMode: config.reasoningMode,
				onSelectDefault: () => config.setEffort(undefined),
				onSelectEffort: config.setEffort,
				onSelectReasoningMode: config.setReasoningMode,
			});
		},
	},
	"dialog.sessions": {
		kind: "dialog",
		title: "Sessions",
		content: () => createElement(SessionsDialogContent),
	},
	"dialog.theme": {
		kind: "dialog",
		title: "Select Theme",
		content: () => createElement(ThemeDialogContent),
	},
	"connection.open": {
		kind: "prepared-dialog",
		title: "Connect",
		content: async ({ connections, refreshAgentRegistry, renderer, toast }) => {
			const connectedProviders = await connections.listProviders();
			return createElement(ConnectDialogContent, {
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
			});
		},
	},
	"dialog.mcps": {
		kind: "dialog",
		title: "MCPs",
		content: () => createElement(McpStatusDialogContent),
	},
	"app.exit": {
		kind: "action",
		run: ({ renderer }) => renderer.destroy(),
	},
} satisfies { [Action in CommandActionId]: CommandStrategy<Action> };

/** Bind the strategy registry to the current TUI dependencies. */
export function createCommandHandlers(
	context: CommandStrategyContext
): CommandHandlerMap {
	const handlers = {} as CommandHandlerMap;
	for (const command of COMMANDS) {
		const action = command.action;
		const strategy = STRATEGIES[action] as RuntimeStrategy;
		handlers[action] = ((argument?: string) => {
			if (strategy.kind === "action") {
				return strategy.run(context, argument);
			}
			if (strategy.kind === "dialog") {
				return openCommandDialog(context.dialog, {
					children: strategy.content(context, argument),
					title: strategy.title,
				});
			}
			return strategy.content(context, argument).then((children) => {
				openCommandDialog(context.dialog, {
					children,
					title: strategy.title,
				});
			});
		}) as CommandHandlerMap[typeof action];
	}
	return handlers;
}
