import type { Skill } from "@wincode/skills";
import type { CommandItem } from "@/modules/commands/command-item";
import type { CommandSpec } from "@/modules/commands/commands";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { FileMentionOption } from "@/modules/file-mentions";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/session-operation";
import type { ChatPromptSubmission } from "../../utils";
import type { PromptHistoryEntry } from "./history";
import type { SubmitSnapshot } from "./submit";

export type InputOverlayState =
	| { items: []; kind: null; selectedIndex: -1 }
	| {
			allItems: CommandItem[];
			items: CommandItem[];
			kind: "command";
			selectedIndex: number;
	  }
	| { items: FileMentionOption[]; kind: "file-mention"; selectedIndex: number };

export type ChatInputControllerState = {
	cursorOffset: number | null;
	overlay: InputOverlayState;
	text: string;
	textSyncRevision: number;
	recalledFiles: SessionFilePart[];
	recalledFileTokens: Array<{ start: number; token: string }>;
	recalledFilesRevision: number;
	recalledPastedTexts: NonNullable<PromptHistoryEntry["pastedText"]>;
	recalledPastedTextsRevision: number;
};

export type ChatInputControllerActions = {
	onArrowDown: (cursorOffset?: number, textLength?: number) => boolean;
	onArrowUp: (cursorOffset?: number, textLength?: number) => boolean;
	onCtrlC: (
		files: SessionFilePart[],
		fileTokens: Array<{ start: number; token: string }>,
		pastedText: Array<{ text: string; token: string }>
	) => boolean;
	onEnter: () => void;
	onEscape: () => void;
	onItemExecute: (index: number) => void;
	onItemSelect: (index: number) => void;
	onTab: (shift: boolean) => void;
	onTextChange: (
		text: string,
		cursorOffset: number,
		files: SessionFilePart[],
		fileTokens: Array<{ start: number; token: string }>
	) => void;
	onProgrammaticTextChange: (text: string, cursorOffset: number) => void;
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
	disabled: boolean;
	executeCommand: (command: CommandSpec) => void | Promise<void>;
	getCustomCommands: () => Promise<CustomCommandSpec[]>;
	getFileMentionOptions: () => Promise<FileMentionOption[]>;
	getSkills: () => Promise<Skill[]>;
	hideVariants?: boolean;
	hideCompact?: boolean;
	onError: (message: string) => void;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
	onTab: (shift: boolean) => void;
	sessionPromptHistory: PromptHistoryEntry[];
	/**
	 * Whether the composer is submitting into the running Agent Turn's Steering
	 * Lane: it then accepts plain text only, so no attachment, Skill or Custom
	 * Command can be armed inside a turn and no Agent change can happen there.
	 */
	steering?: boolean;
};
