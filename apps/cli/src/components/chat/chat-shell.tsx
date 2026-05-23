import { TextAttributes } from "@opentui/core";
import type { UIMessage } from "ai";
import { ChatMessage } from "./chat-message";
import { ChatTextArea } from "./chat-text-area";
import { ChatError } from "./message-parts";

type ChatShellProps = {
	error?: Error;
	inputKey: number;
	inputWidth: number;
	isBusy: boolean;
	messages: UIMessage[];
	onSubmit: (value: string) => void;
};

export function ChatShell({
	error,
	inputKey,
	inputWidth,
	isBusy,
	messages,
	onSubmit,
}: ChatShellProps) {
	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			<scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
				{messages.length === 0 ? (
					<text attributes={TextAttributes.DIM}>No messages yet.</text>
				) : (
					messages.map((message) => (
						<ChatMessage key={message.id} message={message} />
					))
				)}
			</scrollbox>

			<box flexDirection="column" gap={1} width={inputWidth}>
				<ChatTextArea
					focused={!isBusy}
					height={4}
					onSubmit={onSubmit}
					placeholder="Continue conversation..."
					resetKey={inputKey}
				/>
				<box flexDirection="row" gap={2}>
					<text attributes={TextAttributes.DIM}>Enter send</text>
					<text attributes={TextAttributes.DIM}>Shift+Enter newline</text>
					{isBusy ? <text>Streaming...</text> : null}
				</box>
				{error ? <ChatError message={error.message} /> : null}
			</box>
		</box>
	);
}
