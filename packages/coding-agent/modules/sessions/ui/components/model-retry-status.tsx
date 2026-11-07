import type { AgentId, ModelRetryStatus } from "@wincode/agent-core";
import { useEffect, useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { Spinner } from "@/shared/ui/spinner";

/** One transient status, cleared by the runtime before dispatch or termination. */
export function ModelRetryIndicator({
	status,
	agent,
}: {
	status: ModelRetryStatus;
	agent: AgentId;
}) {
	const { colors } = useTheme();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.max(0, Math.ceil((status.retryAt - now) / 1000));
	return (
		<box alignItems="center" flexDirection="row" gap={1}>
			<Spinner agent={agent} color={colors.warning} />
			<text
				fg={colors.textMuted}
			>{`Retrying (${status.attempt}/${status.maxAttempts}) in ${seconds}s... (esc to cancel)`}</text>
		</box>
	);
}
