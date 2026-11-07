import type {
	AgentTurnEvent,
	ModelStepId,
	ModelStepRetryEndOutcome,
	OperationalFailure,
} from "@wincode/agent-core";
import type { CompactionId, SessionId } from "@/shared/identifiers";

export type CompactionSummaryRetryStatus = Readonly<{
	attempt: number;
	compactionId: CompactionId;
	maxRetries: number;
	modelId: string;
	providerId: string;
	retryAt: number;
}>;

type CompactionSummaryRetryContext = Readonly<{
	attempt: number;
	compactionId: CompactionId;
	maxRetries: number;
	modelId: string;
	providerId: string;
	sessionId: SessionId;
	stepId: ModelStepId;
}>;

export type CompactionSummaryAttemptStartedEvent =
	CompactionSummaryRetryContext &
		Readonly<{ type: "compaction-summary-attempt-started" }>;

export type CompactionSummaryRetryScheduledEvent =
	CompactionSummaryRetryContext &
		Readonly<{
			failure: OperationalFailure;
			retryAt: number;
			type: "compaction-summary-retry-scheduled";
		}>;

export type CompactionSummaryRetryEndedEvent = CompactionSummaryRetryContext &
	Readonly<{
		failure?: OperationalFailure;
		outcome: ModelStepRetryEndOutcome;
		type: "compaction-summary-retry-ended";
	}>;

export type SessionCompactionRetryEvent =
	| CompactionSummaryAttemptStartedEvent
	| CompactionSummaryRetryScheduledEvent
	| CompactionSummaryRetryEndedEvent;

/** All observations a public Session SDK handle can receive. */
export type SessionSdkEvent = AgentTurnEvent | SessionCompactionRetryEvent;
