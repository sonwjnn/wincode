import { TextAttributes } from "@opentui/core";
import { useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ConversationCompaction } from "../../compaction";

const TRIGGER_LABELS: Record<ConversationCompaction["trigger"], string> = {
	manual: "manual",
	threshold: "automatic",
	"mid-turn": "mid-turn",
	overflow: "overflow recovery",
};

export const formatCompactionDivider = (
	entry: Pick<
		ConversationCompaction,
		"tokensAfter" | "tokensBefore" | "trigger"
	>
): string =>
	`── Compacted (${TRIGGER_LABELS[entry.trigger]}) · ${entry.tokensBefore} → ${entry.tokensAfter} tokens ──`;

export function CompactionDivider({
	entry,
}: {
	entry: ConversationCompaction;
}) {
	const { colors } = useTheme();
	const [expanded, setExpanded] = useState(false);
	return (
		<box flexDirection="column" width="100%">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
			<text
				attributes={TextAttributes.DIM}
				fg={colors.textMuted}
				onMouseDown={() => setExpanded((value) => !value)}
			>
				{`${formatCompactionDivider(entry)} ${expanded ? "▾" : "▸"}`}
			</text>
			{expanded ? (
				<box border={["left"]} borderColor={colors.textMuted} paddingLeft={1}>
					<text fg={colors.text}>{entry.summary.text}</text>
				</box>
			) : null}
		</box>
	);
}
