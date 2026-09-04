export const agentInvariantCodes = [
	"duplicate-terminal-outcome",
	"invalid-event",
	"invalid-record",
	"invalid-registry",
	"invalid-runtime",
	"invalid-transition",
	"missing-terminal-outcome",
	"sequence-out-of-order",
	"tool-not-found",
	"turn-mismatch",
] as const;
export type AgentInvariantCode = (typeof agentInvariantCodes)[number];

/**
 * A programming or contract violation in the Wincode Agent boundary. Expected
 * provider/runtime failures must become Operational Failures instead.
 */
export class AgentInvariantError extends Error {
	readonly code: AgentInvariantCode;

	constructor(
		code: AgentInvariantCode,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.code = code;
		this.name = "AgentInvariantError";
	}
}

export const isAgentInvariantError = (
	value: unknown
): value is AgentInvariantError => value instanceof AgentInvariantError;
