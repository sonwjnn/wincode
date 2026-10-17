import type { CliRenderer } from "@opentui/core";
import type { ProviderModel } from "@wincode/ai";
import open from "open";
import { createElement, type ReactNode } from "react";
import {
	COMMANDS,
	type CommandActionId,
	type CommandDefinitionFor,
} from "@/modules/commands/commands";
import type { CommandHandlerMap } from "@/modules/commands/execute-command";
import type { PromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import { ThemeDialogContent } from "@/modules/prompt-settings/ui/theme-dialog";
import { ThinkingLevelDialogContent } from "@/modules/prompt-settings/ui/thinking-level-dialog";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	type ProviderModelSelection,
	supportedProviderThinkingLevels,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import { ProviderSdkConnectDialogContent } from "@/modules/providers/ui/provider-sdk-connect-dialog";
import { SessionsDialogContent } from "@/modules/sessions/ui/dialogs/sessions-dialog";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { ToastContextValue } from "@/shared/providers/toast/toast-provider";
import { copyBrowserAuthorizationUrl } from "./browser-authorization";
import { openCommandDialog } from "./dialog-command";

export type CommandStrategyContext = {
	config: PromptConfig;
	dialog: Pick<DialogContextValue, "open">;
	getRecentModelSelections?: (limit: number) => ProviderModelSelection[];
	navigateHome: () => void;
	onSelectProviderModel?: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => void | Promise<void>;
	providerController?: InteractiveProviderController;
	providerModel?: ProviderModel;
	onCompact?: (focus?: string) => boolean | Promise<boolean>;
	onReload: () => Promise<void>;
	onTrust: () => Promise<void>;
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
	"application.reload": {
		kind: "action",
		run: ({ onReload }) => onReload(),
	},
	"project.trust": {
		kind: "action",
		run: ({ onTrust }) => onTrust(),
	},
	"agent.select": {
		kind: "prepared-dialog",
		title: "Select Agent",
		content: async ({ config, providerController }) => {
			if (providerController === undefined) {
				throw new Error(
					"Provider Model availability is unavailable in this view."
				);
			}
			return createElement(AgentsDialogContent, {
				availableProviderModels: await providerController.getAvailableModels(),
				currentAgent: config.agent,
				providerController,
				onSelectAgent: (agent, model) => {
					config.setAgent(agent);
					if (model !== undefined) {
						config.setModelForFutureSubmissions(model);
					}
				},
			});
		},
	},
	"model.select": {
		kind: "dialog",
		title: "Select Model",
		content: ({
			config,
			getRecentModelSelections,
			onSelectProviderModel,
			providerController,
		}) => {
			if (!(providerController && onSelectProviderModel)) {
				throw new Error(
					"Provider Model selection is unavailable in this view."
				);
			}
			return createElement(ProviderModelsDialogContent, {
				controller: providerController,
				currentModel: config.model,
				onSelectModel: onSelectProviderModel,
				recentSelections: getRecentModelSelections?.(10) ?? [],
			});
		},
	},
	"provider.model.select": {
		kind: "dialog",
		title: "Provider SDK Models",
		content: ({
			config,
			getRecentModelSelections,
			onSelectProviderModel,
			providerController,
		}) => {
			if (!(providerController && onSelectProviderModel)) {
				throw new Error(
					"Provider Model selection is unavailable in this view."
				);
			}
			return createElement(ProviderModelsDialogContent, {
				controller: providerController,
				currentModel: config.model,
				onSelectModel: onSelectProviderModel,
				recentSelections: getRecentModelSelections?.(10) ?? [],
			});
		},
	},
	"provider.connect": {
		kind: "dialog",
		title: "Connect Provider SDK",
		content: ({ providerController }) => {
			if (!providerController) {
				throw new Error("Provider SDK connection is unavailable in this view.");
			}
			return createElement(ProviderSdkConnectDialogContent, {
				controller: providerController,
			});
		},
	},

	"thinking.select": {
		kind: "dialog",
		title: "Select Thinking Level",
		content: ({ config, providerModel }) => {
			if (providerModel === undefined) {
				throw new Error(
					"Thinking-level selection is unavailable in this view."
				);
			}
			const levels = supportedProviderThinkingLevels(providerModel);
			if (levels.length === 0) {
				throw new Error(
					"Thinking-level selection is unavailable in this view."
				);
			}
			return createElement(ThinkingLevelDialogContent, {
				currentThinkingLevel: config.thinkingLevel,
				thinkingLevels: levels,
				onSelectDefault: () =>
					config.setThinkingLevelForFutureSubmissions(undefined),
				onSelectThinkingLevel: config.setThinkingLevelForFutureSubmissions,
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
		kind: "dialog",
		title: "Connect",
		content: ({ providerController, renderer, toast }) => {
			if (providerController === undefined) {
				throw new Error("Provider SDK connection is unavailable in this view.");
			}
			return createElement(ProviderSdkConnectDialogContent, {
				controller: providerController,
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
			});
		},
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
