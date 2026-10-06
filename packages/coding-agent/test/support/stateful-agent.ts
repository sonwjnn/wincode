import { createStatefulAgent } from "@wincode/agent-core";
import type {
	AgentSessionPorts,
	SessionQueuedSubmission,
} from "@/modules/sessions/agent-session/types";

/** Creates the real input scheduler with an inert runtime for Agent Session tests. */
export const createTestInputScheduler =
	(): AgentSessionPorts["inputScheduler"] =>
		createStatefulAgent<SessionQueuedSubmission>({
			getQueuedSubmissionId: ({ id }) => id,
			runtime: {
				run: () => ({
					async *[Symbol.asyncIterator]() {
						// Tests using this scheduler do not execute Agent Turns.
					},
				}),
			},
		});
