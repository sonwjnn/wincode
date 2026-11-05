import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionForkProvenance } from "../../storage/session-store";
import type { SessionStatisticsUsageTotals } from "../../usage/session-statistics";

type SessionForkProvenanceBannerProps = Readonly<{
	inheritedUsage: SessionStatisticsUsageTotals;
	provenance: SessionForkProvenance;
}>;

const inheritedUsageLabel = (usage: SessionStatisticsUsageTotals): string => {
	const costs = usage.costs.map(
		({ amount, model, unit }) =>
			`${model.providerId}/${model.modelId}: ${amount} ${unit}`
	);
	if (usage.unknownCostCount > 0) {
		costs.push(`${usage.unknownCostCount} cost unknown`);
	}
	return `${usage.inputTokens ?? "unknown"} input / ${usage.outputTokens ?? "unknown"} output tokens; ${costs.length === 0 ? "no persisted cost" : costs.join(", ")}`;
};

export function SessionForkProvenanceBanner({
	inheritedUsage,
	provenance,
}: SessionForkProvenanceBannerProps) {
	const { colors } = useTheme();
	return (
		<>
			<text fg={colors.textMuted} id="session-fork-provenance">
				{`Forked from Session ${provenance.sourceSessionId} at Record ${provenance.sourceRecordId}, message ${provenance.sourceMessageId} (sequence ${provenance.sourceSequence}).`}
			</text>
			{provenance.sourceAvailability === "unavailable" ? (
				<text fg={colors.textMuted}>
					Source Session is no longer available; inherited context and
					attachments remain available.
				</text>
			) : null}
			<text fg={colors.textMuted}>
				{`Inherited usage is historical, not new Session spend: ${inheritedUsageLabel(inheritedUsage)}.`}
			</text>
		</>
	);
}
