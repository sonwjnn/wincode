import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";

export type ChatCommandContext = {
	exit: () => void;
	newSession: () => void;
};

type ChatCommand = {
	run: (context: ChatCommandContext) => void;
};

const CHAT_COMMANDS = {
	"/exit": {
		run: ({ exit }) => exit(),
	},
	"/new": {
		run: ({ newSession }) => newSession(),
	},
} as const satisfies Record<string, ChatCommand>;

export const runChatCommand = (value: string, context: ChatCommandContext) => {
	const command = CHAT_COMMANDS[value as keyof typeof CHAT_COMMANDS];

	if (!command) {
		return false;
	}

	command.run(context);
	return true;
};

export const useChatCommands = () => {
	const renderer = useRenderer();
	const router = useRouter();

	return {
		runCommand: (value: string) =>
			runChatCommand(value, {
				exit: () => renderer.destroy(),
				newSession: () => {
					router.navigate({ to: "/" }).catch(() => undefined);
				},
			}),
	};
};
