import { formatModelTokenCount, formatModelUsdAmount } from "@wincode/ai";
import { isNull } from "@wincode/utils";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionUsageSummary } from "../../usage/session-usage";

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_ERROR_PERCENT = 90;

const contextColorForPercent = (
	percent: number | null
): "error" | "textMuted" | "warning" => {
	if (percent === null || percent <= CONTEXT_WARNING_PERCENT) {
		return "textMuted";
	}
	if (percent <= CONTEXT_ERROR_PERCENT) {
		return "warning";
	}
	return "error";
};

type SessionUsageBarProps = {
	autoCompact?: boolean;
	summary: SessionUsageSummary;
};

const tokenStatsForSummary = (summary: SessionUsageSummary): string => {
	const uncachedInputTokens = Math.max(
		0,
		summary.inputTokens - summary.cacheReadTokens - summary.cacheWriteTokens
	);
	return [
		uncachedInputTokens > 0
			? `↑${formatModelTokenCount(uncachedInputTokens)}`
			: null,
		summary.outputTokens > 0
			? `↓${formatModelTokenCount(summary.outputTokens)}`
			: null,
		summary.cacheReadTokens > 0
			? `R${formatModelTokenCount(summary.cacheReadTokens)}`
			: null,
		summary.cacheWriteTokens > 0
			? `W${formatModelTokenCount(summary.cacheWriteTokens)}`
			: null,
		(summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0) &&
		summary.cacheHitPercent !== null
			? `CH${summary.cacheHitPercent.toFixed(1)}%`
			: null,
	]
		.filter((stat) => stat !== null)
		.join(" ");
};

export function SessionUsageBar({
	autoCompact = false,
	summary,
}: SessionUsageBarProps) {
	const { colors } = useTheme();
	const tokensText = formatModelTokenCount(summary.contextTokens);
	const contextPercent =
		summary.contextLimit > 0
			? Math.max(0, (summary.contextTokens / summary.contextLimit) * 100)
			: null;
	const percentColor = colors[contextColorForPercent(contextPercent)];
	const estimateMarker = summary.contextSource === "measured" ? "" : "~";
	const contextText =
		contextPercent === null
			? tokensText
			: `${estimateMarker}${contextPercent.toFixed(1)}%/${formatModelTokenCount(
					summary.contextLimit
				).toLowerCase()}`;
	const tokenStats = tokenStatsForSummary(summary);

	return (
		<box flexDirection="row" flexShrink={0}>
			<text fg={colors.textMuted}>
				{tokenStats.length > 0 ? <span>{tokenStats}</span> : null}
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
				{contextPercent === null ? (
					<span>{`  ${contextText}`}</span>
				) : (
					<span fg={percentColor}>{`  ${contextText}`}</span>
				)}
				{autoCompact ? <span> (auto)</span> : null}
			</text>
		</box>
	);
}
