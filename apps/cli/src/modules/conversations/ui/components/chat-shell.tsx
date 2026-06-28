import { TextAttributes } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useTheme } from "@/shared/terminal/theme/theme-provider";
import { ErrorMessage } from "../messages";
import { ChatMessage } from "./chat-message";
import { ChatTextArea } from "./chat-text-area";
import { Spinner } from "./spinner";

type ChatShellProps = {
	error?: Error;
	isBusy: boolean;
	isInterruptArmed: boolean;
	messages: CodingAgentUIMessage[];
	onSubmit: (value: string) => void;
};

export function ChatShell({
	error,
	isBusy,
	isInterruptArmed,
	messages,
	onSubmit,
}: ChatShellProps) {
	const { mode } = usePromptConfig();
	const { colors } = useTheme();

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			gap={1}
			height="100%"
			paddingX={2}
			paddingY={1}
			width="100%"
		>
			<scrollbox flexGrow={1} height="100%" stickyScroll stickyStart="bottom">
				<box flexDirection="column" gap={1}>
					{messages.length === 0 && !error ? (
						<text attributes={TextAttributes.DIM}>No messages yet.</text>
					) : (
						messages.map((message) => (
							<ChatMessage key={message.id} message={message} />
						))
					)}
					{error ? <ErrorMessage message={error.message} /> : null}
				</box>
			</scrollbox>

			<box flexShrink={0}>
				<ChatTextArea onSubmit={onSubmit} />
			</box>
			<box
				flexDirection="row"
				flexShrink={0}
				gap={2}
				height={1}
				justifyContent="space-between"
				paddingLeft={1}
				width="100%"
			>
				<box alignItems="center" flexDirection="row" gap={2}>
					{isBusy ? (
						<>
							<Spinner mode={mode} />
							<text>
								<span fg={colors.mode[mode]}>Esc</span>
								<span fg={colors.dimSeparator}>
									{isInterruptArmed ? " again to interrupt" : " interrupt"}
								</span>
							</text>
						</>
					) : null}
				</box>

				<box flexDirection="row" flexShrink={0} gap={1} marginLeft="auto">
					<text>tab</text>
					<text attributes={TextAttributes.DIM}>agents</text>
				</box>
			</box>
		</box>
	);
}
