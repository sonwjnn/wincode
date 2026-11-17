import type {
	CommandController,
	CommandSuggestion,
} from "@/modules/commands/command-controller";
import type { FileMentionOption } from "@/modules/file-mentions";
import type {
	PluginAutocompleteItem,
	PluginAutocompleteProviderFactory,
} from "@/modules/plugins/public";
import type { PromptHistoryStore } from "@/modules/sessions/storage/prompt-history";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import type { ComposerDocument } from "../../ui/composer-document";
import type { ChatPromptComposition, ChatPromptSubmission } from "../../utils";
import type { PromptHistoryEntry } from "./history";
import type { SubmitSnapshot } from "./submit";

export type InputOverlayState =
	| { items: []; kind: null; selectedIndex: -1 }
	| {
			allItems: readonly CommandSuggestion[];
			items: readonly CommandSuggestion[];
			kind: "command";
			selectedIndex: number;
	  }
	| { items: FileMentionOption[]; kind: "file-mention"; selectedIndex: number }
	| {
			items: readonly PluginAutocompleteItem[];
			kind: "plugin-autocomplete";
			prefix: string;
			selectedIndex: number;
	  }
	| {
			items: readonly PluginAutocompleteItem[];
			kind: "plugin-argument";
			prefix: string;
			selectedIndex: number;
	  };

export type ChatInputControllerState = {
	overlay: InputOverlayState;
	text: string;
};

export type ChatInputControllerActions = {
	onArrowDown: (cursorOffset?: number, textLength?: number) => boolean;
	onArrowUp: (cursorOffset?: number, textLength?: number) => boolean;
	onCtrlC: (composition: SessionSubmissionComposition) => boolean;
	onCursorChange: () => void;
	onEnter: () => void;
	onEscape: () => void;
	onItemExecute: (index: number) => void;
	onItemSelect: (index: number) => void;
	onTab: (shift: boolean) => void;
	nextPrompt: () => boolean;
	previousPrompt: () => boolean;
	onTextChange: (
		composition: SessionSubmissionComposition,
		cursorOffset: number,
		previousText: string
	) => void;
	/**
	 * Restores recalled compositions into the composer, oldest first and below
	 * what the composer already holds. The draft carries the composer's own
	 * state, because only the textarea knows its attachments and pasted text.
	 */
	recall: (
		entries: readonly ChatPromptComposition[],
		draft: ChatPromptComposition
	) => void;
	submit: (snapshot: SubmitSnapshot) => Promise<boolean>;
};

export type ChatInputController = {
	actions: ChatInputControllerActions;
	state: ChatInputControllerState;
};

export type ChatInputControllerOptions = {
	composerDocument: ComposerDocument;
	disabled: boolean;
	commandController: CommandController;
	pluginAutocompleteProviders?: readonly PluginAutocompleteProviderFactory[];
	sessionId?: string;
	/** Ephemeral key whose composer text survives a remount (e.g. a session id). */
	draftKey?: string;
	getFileMentionOptions: () => Promise<FileMentionOption[]>;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
	onTab: (shift: boolean) => void;
	sessionPromptHistory: PromptHistoryEntry[];
	promptHistoryStore?: PromptHistoryStore;
};
