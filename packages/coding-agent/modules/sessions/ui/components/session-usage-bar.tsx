import { TextAttributes } from "@opentui/core";
import {
	formatModelTokenCount,
	formatModelUsdAmount,
} from "@wincode/ai/model-usage";
import { isNull } from "@wincode/runtime-utils";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionUsageSummary } from "../../usage/session-usage";

const CONTEXT_WARNING_PERCENT = 80;
const CONTEXT_LIMIT_FORMAT_OPTIONS = { preserveTrailingZero: true };

export function SessionUsageBar({ summary }: { summary: SessionUsageSummary }) {
	const { colors } = useTheme();
	const tokensText = formatModelTokenCount(summary.contextTokens);
	const percentColor =
		!isNull(summary.contextPercent) &&
		summary.contextPercent >= CONTEXT_WARNING_PERCENT
			? colors.error
			: colors.textMuted;

	return (
		<box flexDirection="row" flexShrink={0}>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				{!(isNull(summary.contextPercent) || isNull(summary.contextLimit)) &&
				summary.contextLimit > 0 ? (
					<>
						<span fg={percentColor}>{summary.contextPercent}%</span>
						<span>
							{`(${tokensText}/${formatModelTokenCount(
								summary.contextLimit,
								CONTEXT_LIMIT_FORMAT_OPTIONS
							)})`}
						</span>
					</>
				) : (
					<span>{tokensText}</span>
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
