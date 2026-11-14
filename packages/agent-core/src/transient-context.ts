import { type SessionMessageId, toSessionMessageId } from "./identifiers";

/**
 * Identifiers the runtime injects as turn-scoped context. They reach the model
 * but are never committed to a Session Record, so projections, sanitization and
 * rebasing skip them and each turn replaces them.
 */
export const SKILL_CONTEXT_MESSAGE_ID = toSessionMessageId("skill-context");
export const ENVIRONMENT_CONTEXT_MESSAGE_ID = toSessionMessageId(
	"environment-context"
);
export const TRANSIENT_CONTEXT_MESSAGE_IDS: readonly SessionMessageId[] = [
	SKILL_CONTEXT_MESSAGE_ID,
	ENVIRONMENT_CONTEXT_MESSAGE_ID,
];

const TRANSIENT_CONTEXT_ID_SET: ReadonlySet<string> = new Set(
	TRANSIENT_CONTEXT_MESSAGE_IDS
);

export const isTransientContextMessageId = (id: string): boolean =>
	TRANSIENT_CONTEXT_ID_SET.has(id);
