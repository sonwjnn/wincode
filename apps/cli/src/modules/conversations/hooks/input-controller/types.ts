import type { FileUIPart } from "@wincode/ai/client";
import type { CommandSpec } from "@/modules/commands/commands";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { FileMentionOption } from "@/modules/file-mentions";
import type { Skill } from "@/modules/skills";
import type { ChatPromptSubmission } from "../../utils";
import type { PromptHistoryEntry } from "./history";
import type { SubmitSnapshot } from "./submit";

export type CommandItem = CommandSpec | CustomCommandSpec;

export type InputOverlayState =
	| { items: []; kind: null; selectedIndex: -1 }
	| { items: CommandItem[]; kind: "command"; selectedIndex: number }
	| { items: FileMentionOption[]; kind: "file-mention"; selectedIndex: number };

export type ChatInputControllerState = {
	cursorOffset: number | null;
	overlay: InputOverlayState;
	text: string;
	textSyncRevision: number;
	recalledFiles: FileUIPart[];
	recalledFileTokens: Array<{ start: number; token: string }>;
	recalledFilesRevision: number;
	recalledPastedTexts: NonNullable<PromptHistoryEntry["pastedText"]>;
	recalledPastedTextsRevision: number;
	visibleStartIndex: number;
};

export type ChatInputControllerActions = {
	onArrowDown: (cursorOffset?: number, textLength?: number) => boolean;
	onArrowUp: (cursorOffset?: number, textLength?: number) => boolean;
	onCtrlC: (
		files: FileUIPart[],
		fileTokens: Array<{ start: number; token: string }>,
		pastedText: Array<{ text: string; token: string }>
	) => boolean;
	onEnter: () => void;
	onEscape: () => void;
	onItemExecute: (index: number) => void;
	onItemScroll: (direction: "up" | "down") => void;
	onItemSelect: (index: number) => void;
	onTab: () => void;
	onTextChange: (
		text: string,
		cursorOffset: number,
		files: FileUIPart[],
		fileTokens: Array<{ start: number; token: string }>
	) => void;
	onProgrammaticTextChange: (text: string, cursorOffset: number) => void;
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
	onError: (message: string) => void;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
	onTab: () => void;
	sessionPromptHistory: PromptHistoryEntry[];
};
