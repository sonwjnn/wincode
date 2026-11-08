import type { AgentId } from "@wincode/agent-core";
import {
	type AgentRegistry,
	resolveActiveAgentId,
} from "@/modules/agents/registry";

export const IMPORTED_SESSION_COMPACTION_ACTIVATION_REQUIRED_MESSAGE =
	"Imported Session must be continued or receive new input before compaction.";

export const assertImportedSessionAgentIsAvailable = (
	registry: AgentRegistry | null,
	sourceAgent: AgentId | undefined,
	isImportedSession: boolean
): void => {
	if (
		!isImportedSession ||
		sourceAgent === undefined ||
		(registry !== null &&
			resolveActiveAgentId(registry, sourceAgent) === sourceAgent)
	) {
		return;
	}
	throw new Error(
		`Imported Session Agent '${sourceAgent}' is unavailable in this destination. Configure that Agent before opening the Session.`
	);
};
