import type { AgentId } from "@wincode/agent-core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { Spinner } from "@/shared/ui/spinner";

export function CompactionStatus({
	agent,
	autoCompact,
}: {
	agent: AgentId;
	autoCompact: boolean;
}) {
	const { colors } = useTheme();
	return (
		<box alignItems="center" flexDirection="row" gap={1} width="100%">
			<Spinner agent={agent} />
			<text fg={colors.textMuted}>
				{autoCompact ? "Auto-compacting..." : "Compacting..."}
			</text>
		</box>
	);
}
