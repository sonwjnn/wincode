import { TextAttributes } from "@opentui/core";
import { formatModelTokenCount } from "@wincode/ai/model-usage";
import { useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionCompaction } from "../../compaction";

const TRIGGER_LABELS: Record<SessionCompaction["trigger"], string> = {
	manual: "manual",
	threshold: "automatic",
	"mid-turn": "mid-turn",
	overflow: "overflow recovery",
};

export const formatCompactionDivider = (
	entry: Pick<
		SessionCompaction,
		"estimatedTokensAfter" | "tokensBefore" | "trigger"
	>
): string =>
	`Compacted (${TRIGGER_LABELS[entry.trigger]}) · ${formatModelTokenCount(entry.tokensBefore)}→${formatModelTokenCount(entry.estimatedTokensAfter)} tokens`;

export function CompactionDivider({ entry }: { entry: SessionCompaction }) {
	const { colors } = useTheme();
	const [expanded, setExpanded] = useState(false);
	return (
		<box flexDirection="column" gap={1} width="100%">
			<box alignItems="center" flexDirection="row" gap={1} width="100%">
				<box
					border={["bottom"]}
					borderColor={colors.textMuted}
					flexGrow={1}
					height={1}
				/>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
				<text
					attributes={TextAttributes.DIM}
					fg={colors.textMuted}
					onMouseDown={() => setExpanded((value) => !value)}
				>
					<span>{formatCompactionDivider(entry)}</span>
					<span>{expanded ? " ▾" : " ▸"}</span>
				</text>
				<box
					border={["bottom"]}
					borderColor={colors.textMuted}
					flexGrow={1}
					height={1}
				/>
			</box>
			{expanded ? (
				<box border={["left"]} borderColor={colors.textMuted} paddingLeft={1}>
					<text fg={colors.text}>{entry.summary.text}</text>
				</box>
			) : null}
		</box>
	);
}
