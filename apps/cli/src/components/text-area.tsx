import type { TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useRef } from "react";

export function HomeTextArea() {
	const { width } = useTerminalDimensions();
	const textAreaRef = useRef<TextareaRenderable>(null);

	const promptWidth = Math.max(32, Math.min(width - 8, 72));

	const handleSubmit = () => {
		console.log("submit value: ", textAreaRef.current?.plainText);
	};

	return (
		<box flexDirection="column" gap={1} width={promptWidth}>
			<box
				backgroundColor="#111111"
				border
				borderColor="#3a3a3a"
				borderStyle="rounded"
				paddingX={1}
			>
				<textarea
					backgroundColor="#111111"
					cursorColor="#7c3aed"
					focused
					focusedBackgroundColor="#111111"
					focusedTextColor="#f5f5f5"
					height={6}
					keyBindings={[
						{ name: "return", action: "newline", shift: true },
						{ name: "return", action: "submit" },
					]}
					onSubmit={handleSubmit}
					placeholder="What would you like to build?"
					placeholderColor="#6b7280"
					ref={textAreaRef}
					textColor="#f5f5f5"
					width={promptWidth - 4}
					wrapMode="word"
				/>
			</box>
		</box>
	);
}
