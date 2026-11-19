import type { ModelRetryStatus } from "@wincode/agent-core";
import { LocalStyleProvider, StatusFeedback } from "@wincode/tui";
import { useEffect, useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";

/** One transient status, cleared by the runtime before dispatch or termination. */
export function ModelRetryIndicator({
	status,
	operation = "agent-turn",
}: {
	status: ModelRetryStatus;
	operation?: "agent-turn" | "compaction-summary";
}) {
	const { colors } = useTheme();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.max(0, Math.ceil((status.retryAt - now) / 1000));
	const label =
		operation === "compaction-summary"
			? "Retrying compaction summary"
			: "Retrying";
	return (
		<LocalStyleProvider colors={{ info: colors.warning }}>
			<StatusFeedback
				message={`${label} (${status.attempt}/${status.maxAttempts}) in ${seconds}s... (esc to cancel)`}
				progress={{ current: status.attempt, total: status.maxAttempts }}
				status="progress"
			/>
		</LocalStyleProvider>
	);
}
