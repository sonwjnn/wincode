import { TextAttributes } from "@opentui/core";
import {
	formatModelTokenCount,
	formatModelUsdAmount,
} from "@wincode/ai/model-usage";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionUsageSummary } from "../../usage/session-usage";

const CONTEXT_WARNING_PERCENT = 80;

export function SessionUsageBar({ summary }: { summary: SessionUsageSummary }) {
	const { colors } = useTheme();
	const tokensText = formatModelTokenCount(summary.contextTokens);
	const percentColor =
		summary.contextPercent !== null &&
		summary.contextPercent >= CONTEXT_WARNING_PERCENT
			? colors.error
			: colors.textMuted;

	return (
		<box flexDirection="row" flexShrink={0}>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				<span>{tokensText}</span>
				{summary.contextPercent === null ? null : (
					<>
						<span> (</span>
						<span fg={percentColor}>{summary.contextPercent}%</span>
						<span>)</span>
					</>
				)}
				{summary.costUsd === null ? null : (
					// "~" marks a figure derived from published rates instead of an
					// invoice. See ADR-0015.
					<span>{`  ~${formatModelUsdAmount(summary.costUsd)}`}</span>
				)}
			</text>
		</box>
	);
}
