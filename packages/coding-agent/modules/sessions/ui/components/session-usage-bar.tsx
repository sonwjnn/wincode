import { formatModelTokenCount, formatModelUsdAmount } from "@wincode/ai";
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
	const estimateMarker = summary.contextSource === "measured" ? "" : "~";
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
					<span>
						{estimateMarker}
						{contextText}
					</span>
				) : (
					<span fg={percentColor}>
						{estimateMarker}
						{contextText}
					</span>
				)}
				{autoCompact ? <span> (auto)</span> : null}
				{summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0 ? (
					<span>{` ↑${formatModelTokenCount(
						summary.cacheReadTokens
					)} ↓${formatModelTokenCount(summary.cacheWriteTokens)}`}</span>
				) : null}
				{summary.cacheWarmingStatus === "idle" ? null : (
					<span>
						{summary.cacheWarmingStatus === "scheduled"
							? "  cache warming scheduled"
							: "  cache warming"}
					</span>
				)}
				{isNull(summary.costUsd) ? (
					<span> cost unknown</span>
				) : (
					// "~" marks a figure derived from published rates instead of an
					// invoice. See ADR-0015. Partial totals exclude unpriced usage.
					<span>{`  ~${formatModelUsdAmount(summary.costUsd)}${summary.costCoverage === "partial" ? " (partial)" : ""}`}</span>
				)}
			</text>
		</box>
	);
}
