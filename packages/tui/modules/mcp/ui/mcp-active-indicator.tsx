import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useMcp } from "../context/mcp-provider";

/** Footer indicator: `⊙ 3 MCP/mcps` — connected server count with the `/mcps` hint. */
export function McpActiveIndicator() {
	const { isLoading, statuses } = useMcp();
	const { colors } = useTheme();
	const activeCount = statuses.filter(
		(status) => status.state === "connected"
	).length;

	return (
		<box flexDirection="row" flexShrink={0} gap={1}>
			<text fg={colors.success}>⊙</text>
			<text fg={colors.text}>
				{isLoading
					? "Loading..."
					: `${activeCount} MCP${activeCount === 1 ? "" : "s"}`}
			</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				/mcps
			</text>
		</box>
	);
}
