import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "../../providers/keyboard-layer/constants";
import { usePromptConfig } from "../../providers/prompt-config";
import { useTheme } from "../../providers/theme";
import { useToast } from "../../providers/toast";
import { EmptyBorder } from "../border";
import { CommandMenu } from "../command-menu";
import {
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
} from "../command-menu/adapters";
import type { CommandSpec } from "../command-menu/commands";
import { createCommandExecutor } from "../command-menu/execute-command";
import { useCommandMenu } from "../command-menu/use-command-menu";
import {
	AgentsDialogContent,
	ModelsDialogContent,
	SessionsDialogContent,
	ThemeDialogContent,
} from "../dialogs";
import { StatusBar } from "../status-bar";

type ChatTextAreaProps = {
	disabled?: boolean;
	onSubmit: (value: string) => void;
};

type CommandTextBuffer = Pick<TextareaRenderable, "plainText" | "setText">;

export const clearCommandText = (textarea: CommandTextBuffer | null) => {
	if (textarea?.plainText.startsWith("/")) {
		textarea.setText("");
	}
};

const getCommandErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "Command failed";

export function ChatTextArea({
	disabled = false,
	onSubmit,
}: ChatTextAreaProps) {
	const { mode, model, cycleMode, setMode, setModel } = usePromptConfig();
	const textAreaRef = useRef<TextareaRenderable>(null);
	const onSubmitRef = useRef<() => void>(() => {
		// default value
	});

	const renderer = useRenderer();
	const router = useRouter();
	const { isTopLayer, push, pop, setResponder } = useKeyboardLayer();
	const { colors } = useTheme();
	const {
		showCommandMenu,
		commandQuery,
		selectedIndex,
		scrollRef,
		handleContentChange,
		resolveCommand,
		setSelectedIndex,
	} = useCommandMenu();
	const toast = useToast();
	const dialog = useDialog();

	const execute = useMemo(
		() =>
			createCommandExecutor({
				exit: new ExitAdapter({ destroy: () => renderer.destroy() }),
				new: new NewAdapter({
					navigateHome: () => {
						router.navigate({ to: "/" }).catch(() => undefined);
					},
				}),
				dialog: new DialogAdapter({
					open: (key, title) => {
						switch (key) {
							case "sessions":
								dialog.open({
									children: <SessionsDialogContent />,
									title,
								});
								break;
							case "theme":
								dialog.open({
									children: <ThemeDialogContent />,
									title,
								});
								break;
							default:
								break;
						}
					},
				}),
				models: new ModelsAdapter({
					open: ({ models, currentModel, onSelectModel }) => {
						dialog.open({
							children: (
								<ModelsDialogContent
									currentModel={currentModel}
									models={models}
									onSelectModel={onSelectModel}
								/>
							),
							title: "Select Model",
						});
					},
					currentModel: model,
					setModel,
				}),
				mode: new ModeAdapter({
					open: ({ currentMode, onSelectMode }) => {
						dialog.open({
							children: (
								<AgentsDialogContent
									currentMode={currentMode}
									onSelectMode={onSelectMode}
								/>
							),
							title: "Select Agent",
						});
					},
					currentMode: mode,
					setMode,
				}),
				unavailable: new UnavailableAdapter({
					show: (message) => {
						toast.show({ message, variant: "info" });
					},
				}),
			}),
		[dialog.open, renderer, router, mode, model, setMode, setModel, toast.show]
	);

	const handleCommand = useCallback(
		(command: CommandSpec | undefined) => {
			const textarea = textAreaRef.current;
			if (!(textarea && command)) {
				return;
			}

			textarea.setText("");
			execute(command, (error) => {
				toast.show({
					message: getCommandErrorMessage(error),
					variant: "error",
				});
			});
		},
		[execute, toast]
	);

	const handleCommandExecute = useCallback(
		(index: number) => {
			const command = resolveCommand(index);
			handleCommand(command);
		},
		[resolveCommand, handleCommand]
	);

	const handleSubmit = useCallback(() => {
		if (disabled) {
			return;
		}

		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		const text = textarea.plainText.trim();
		if (text.length === 0) {
			return;
		}

		onSubmit(text);
		textarea.setText("");
	}, [disabled, onSubmit]);

	const handleTextareaContentChange = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		const text = textarea.plainText;

		handleContentChange(textarea.plainText);
		// syncMentionMenu(text, textarea.cursorOffset);
	}, [
		handleContentChange,
		// ,syncMentionMenu
	]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.onSubmit = () => {
			onSubmitRef.current();
		};
	}, []);

	onSubmitRef.current = () => {
		if (disabled) {
			return;
		}

		if (showCommandMenu) {
			const command = resolveCommand(selectedIndex);
			handleCommand(command);
			return;
		}

		// if (showMentionMenu) {
		//   const candidate = mentionCandidates[mentionSelectedIndex];
		//   if (candidate) {
		//     handleMentionExecute(mentionSelectedIndex);
		//     return;
		//   }
		// }

		handleSubmit();
	};

	useKeyboard((key) => {
		if (disabled) {
			return;
		}
		if (!isTopLayer("base")) {
			return;
		}
		if (key.name === "tab") {
			key.preventDefault();
			cycleMode();
		}
	});

	useEffect(() => {
		setResponder("base", () => {
			if (disabled) {
				return false;
			}

			const textarea = textAreaRef.current;
			if (textarea && textarea.plainText.length > 0) {
				textarea.setText("");
				return true;
			}
			return false;
		});

		return () => setResponder("base", null);
	}, [disabled, setResponder]);

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={colors.mode[mode]}
				customBorderChars={{
					...EmptyBorder,
					vertical: "┃",
					bottomLeft: "╹",
				}}
				gap={1}
				width="100%"
			>
				<box
					backgroundColor={colors.surface}
					gap={1}
					justifyContent="center"
					paddingX={2}
					paddingY={1}
					position="relative"
					width="100%"
				>
					{showCommandMenu && (
						<box
							backgroundColor={colors.surface}
							bottom="100%"
							left={0}
							position="absolute"
							width="100%"
							zIndex={10}
						>
							<CommandMenu
								onExecute={handleCommandExecute}
								onSelect={setSelectedIndex}
								query={commandQuery}
								scrollRef={scrollRef}
								selectedIndex={selectedIndex}
							/>
						</box>
					)}

					<textarea
						focused={
							!disabled &&
							(isTopLayer("base") ||
								isTopLayer("command") ||
								isTopLayer("mention"))
						}
						keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
						onContentChange={handleTextareaContentChange}
						placeholder={`Ask anything... "Fix broken tests"`}
						ref={textAreaRef}
					/>
					<StatusBar />
				</box>
			</box>
		</box>
	);
}
