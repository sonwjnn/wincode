import { TextAttributes } from "@opentui/core";
import { getCodingMode } from "@wincode/ai";
import { usePromptConfig } from "../providers/prompt-config";

export function StatusBar() {
	const { mode } = usePromptConfig();

	return (
		<box flexDirection="row" gap={1}>
			<text>{getCodingMode(mode).displayName}</text>
			<text attributes={TextAttributes.DIM}>›</text>
		</box>
	);
}
