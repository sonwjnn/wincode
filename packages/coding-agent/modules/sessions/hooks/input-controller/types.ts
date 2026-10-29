import type {
	CommandController,
	CommandSuggestion,
} from "@/modules/commands/command-controller";
import type { FileMentionOption } from "@/modules/file-mentions";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import type { ComposerDocument } from "../../ui/composer-document";
import type { ChatPromptSubmission } from "../../utils";
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
	| { items: FileMentionOption[]; kind: "file-mention"; selectedIndex: number };

export type ChatInputControllerState = {
	overlay: InputOverlayState;
	text: string;
};

export type ChatInputControllerActions = {
	onArrowDown: (cursorOffset?: number, textLength?: number) => boolean;
	onArrowUp: (cursorOffset?: number, textLength?: number) => boolean;
	onCtrlC: (composition: SessionSubmissionComposition) => boolean;
	onEnter: () => void;
	onEscape: () => void;
	onItemExecute: (index: number) => void;
	onItemSelect: (index: number) => void;
	onTab: (shift: boolean) => void;
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
		entries: readonly SessionSubmissionComposition[],
		draft: SessionSubmissionComposition
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
	/** Ephemeral key whose composer text survives a remount (e.g. a session id). */
	draftKey?: string;
	getFileMentionOptions: () => Promise<FileMentionOption[]>;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
	onTab: (shift: boolean) => void;
	sessionPromptHistory: PromptHistoryEntry[];
};
