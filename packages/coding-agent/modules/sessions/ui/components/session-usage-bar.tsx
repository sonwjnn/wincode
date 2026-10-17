import {
	formatModelTokenCount,
	formatModelUsdAmount,
} from "@wincode/ai/model-usage";
import { isNull } from "@wincode/utils";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionUsageSummary } from "../../usage/session-usage";

const CONTEXT_WARNING_PERCENT = 80;

type SessionUsageBarProps = {
	autoCompact?: boolean;
	summary: SessionUsageSummary;
};

export function SessionUsageBar({
	autoCompact = false,
	summary,
}: SessionUsageBarProps) {
	const { colors } = useTheme();
	const tokensText = formatModelTokenCount(summary.contextTokens);
	const contextPercent =
		isNull(summary.contextPercent) ||
		isNull(summary.contextLimit) ||
		summary.contextLimit <= 0
			? null
			: Math.min(
					100,
					Math.max(0, (summary.contextTokens / summary.contextLimit) * 100)
				);
	const percentColor =
		contextPercent !== null && contextPercent >= CONTEXT_WARNING_PERCENT
			? colors.error
			: colors.textMuted;
	const contextText =
		contextPercent === null || isNull(summary.contextLimit)
			? tokensText
			: `${contextPercent.toFixed(1)}%/${formatModelTokenCount(
					summary.contextLimit
				).toLowerCase()}`;

	return (
		<box flexDirection="row" flexShrink={0}>
			<text fg={colors.textMuted}>
				{contextPercent === null ? (
					<span>{contextText}</span>
				) : (
					<span fg={percentColor}>{contextText}</span>
				)}
				{autoCompact ? <span> (auto)</span> : null}
				{summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0 ? (
					<span>{`  cache read ${formatModelTokenCount(
						summary.cacheReadTokens
					)} / write ${formatModelTokenCount(summary.cacheWriteTokens)}`}</span>
				) : null}
				{summary.cacheWarmingStatus === "idle" ? null : (
					<span>
						{summary.cacheWarmingStatus === "scheduled"
							? "  cache warming scheduled"
							: "  cache warming"}
					</span>
				)}
				{isNull(summary.costUsd) ? null : (
					// "~" marks a figure derived from published rates instead of an
					// invoice. See ADR-0015.
					<span>{`  ~${formatModelUsdAmount(summary.costUsd)}`}</span>
				)}
			</text>
		</box>
	);
}
