import type { CommandSpec } from "../../command-menu/commands";

export type InputOverlayState =
	| { items: []; kind: null; selectedIndex: -1 }
	| { items: CommandSpec[]; kind: "command"; selectedIndex: number };

export type ChatInputControllerState = {
	overlay: InputOverlayState;
	text: string;
};

export type ChatInputControllerActions = {
	onArrowDown: () => void;
	onArrowUp: () => void;
	onCtrlC: () => boolean;
	onEnter: () => void;
	onEscape: () => void;
	onItemExecute: (index: number) => void;
	onItemSelect: (index: number) => void;
	onTab: () => void;
	onTextChange: (text: string, cursorOffset: number) => void;
};

export type ChatInputController = {
	actions: ChatInputControllerActions;
	state: ChatInputControllerState;
};

export type ChatInputControllerOptions = {
	disabled: boolean;
	executeCommand: (command: CommandSpec) => void | Promise<void>;
	onSubmit: (value: string) => void;
	onTab: () => void;
};
