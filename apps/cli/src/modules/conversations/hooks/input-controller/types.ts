import type { FileUIPart } from "@wincode/ai/client";
import type { CommandSpec } from "@/modules/commands/commands";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { FileMentionOption } from "@/modules/file-mentions";
import type { PromptHistoryEntry } from "./history";

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
	onAcceptedSubmit: (entry: PromptHistoryEntry) => void;
	onEscape: () => void;
	onItemExecute: (index: number) => void;
	onItemSelect: (index: number) => void;
	onTab: () => void;
	onTextChange: (
		text: string,
		cursorOffset: number,
		files: FileUIPart[],
		fileTokens: Array<{ start: number; token: string }>
	) => void;
	onProgrammaticTextChange: (text: string, cursorOffset: number) => void;
};

export type ChatInputController = {
	actions: ChatInputControllerActions;
	state: ChatInputControllerState;
};

export type ChatInputControllerOptions = {
	disabled: boolean;
	executeCommand: (command: CommandSpec) => void | Promise<void>;
	getCustomCommands: () => Promise<CustomCommandSpec[]>;
	onSubmit: (value: string) => void;
	onTab: () => void;
	getFileMentionOptions: () => Promise<FileMentionOption[]>;
	getPromptHistory: () => PromptHistoryEntry[];
	recordPrompt: (entry: PromptHistoryEntry) => void;
};
