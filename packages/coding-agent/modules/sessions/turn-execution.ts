import {
	type AgentId,
	type AgentTurnDelegation,
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { omitUndefined } from "@wincode/runtime-utils";
import type { McpCatalogSnapshot } from "@/modules/mcp";
import type {
	SkillExecution,
	SkillRequestContext,
	SkillToolDefinition,
} from "@/modules/skills";
import type { ResolvedCodingAgent } from "../agents/built-ins";
import type {
	DelegationExecutor,
	SessionViewState,
} from "./hooks/runtime-turn";

/** The Skill catalog an execution armed for its own turn. */
export type TurnExecutionSkill = {
	readonly execution: SkillExecution;
	readonly tool?: SkillToolDefinition;
};

/**
 * One Agent Turn execution's turn-scoped values. The scope is created when the
 * execution starts and discarded when it ends, so no value can leak into
 * another execution: a delegated Subagent execution carries its parent linkage
 * and never reads its parent's identity, selection, or capabilities through a
 * session-scope holder.
 *
 * `armedSkill`, `delegate`, and `mcpSnapshot` are attached by the execution that
 * owns them while its turn starts — the Skill catalog is armed during
 * submission preparation and the MCP snapshot is created per Agent Turn — and
 * are never rebuilt on render.
 */
export type TurnExecution = {
	/** The Agent the execution runs as. */
	readonly agent: AgentId;
	/** The assistant Session Message the execution streams into. */
	readonly assistantId: SessionMessageId;
	/**
	 * Abort index for this execution tree's in-flight delegated Tool Calls. A
	 * delegated execution shares the index of the execution that started the
	 * tree, so the session's single Tool Gate can route an approval abort to the
	 * execution that owes the call.
	 */
	readonly childAborts: Map<ToolCallId, () => void>;
	/** The Model Target selection the execution runs against. */
	readonly model: ChatModelSelection;
	/** Set for a delegated Subagent execution: the turn and Tool Call it came from. */
	readonly parent?: AgentTurnDelegation;
	readonly resolvedAgent?: ResolvedCodingAgent;
	/** The session-level selection recorded on this execution's Session Records. */
	readonly sessionModel: ChatModelSelection;
	readonly sessionVariant?: ModelVariant;
	/** The Session Context message this execution answers. */
	readonly sourceUserMessageId: SessionMessageId | null;
	readonly startedAt: number;
	readonly turnId: AgentTurnId;
	readonly variant?: ModelVariant;
	/** The Skill catalog armed for the execution's turn, when one was built. */
	armedSkill?: TurnExecutionSkill;
	/**
	 * The delegation bookkeeping created with the execution, so a React
	 * re-render between a Subagent's start and end cannot reset it.
	 */
	delegate?: DelegationExecutor;
	/** The MCP capability snapshot the execution runs against. */
	mcpSnapshot: McpCatalogSnapshot | null;
	/** The Skill, if any, this execution's turn must load. */
	readonly skillRequest?: SkillRequestContext;
};

export type BeginTurnExecutionInput = {
	readonly agent: AgentId;
	/** The Skill catalog armed for the execution's turn, when one was built. */
	readonly armedSkill?: TurnExecutionSkill;
	/** Shares the spawning execution's abort index for a delegated execution. */
	readonly childAborts?: Map<ToolCallId, () => void>;
	readonly model: ChatModelSelection;
	readonly parent?: AgentTurnDelegation;
	readonly resolvedAgent?: ResolvedCodingAgent;
	readonly sessionModel: ChatModelSelection;
	readonly sessionVariant?: ModelVariant;
	/** The Skill, if any, this execution's turn must load. */
	readonly skillRequest?: SkillRequestContext;
	/** The Session Context message this execution answers, when known. */
	readonly sourceUserMessageId?: SessionMessageId;
	readonly startedAt: number;
	/** The Agent Turn Identifier; generated when the caller has none yet. */
	readonly turnId?: AgentTurnId;
	readonly variant?: ModelVariant;
};

export const createTurnExecution = ({
	agent,
	armedSkill,
	childAborts,
	model,
	parent,
	resolvedAgent,
	sessionModel,
	sessionVariant,
	skillRequest,
	sourceUserMessageId,
	startedAt,
	turnId: providedTurnId,
	variant,
}: BeginTurnExecutionInput): TurnExecution => {
	const turnId = providedTurnId ?? createAgentTurnId();
	return {
		agent,
		...omitUndefined({
			armedSkill,
			parent,
			resolvedAgent,
			sessionVariant,
			skillRequest,
			variant,
		}),
		assistantId: toSessionMessageId(`assistant-${turnId}`),
		childAborts: childAborts ?? new Map(),
		mcpSnapshot: null,
		model,
		sessionModel,
		sourceUserMessageId: sourceUserMessageId ?? null,
		startedAt,
		turnId,
	};
};

/**
 * Starts, ends, and publishes the Session View State of Agent Turn
 * executions. The binding supplies it, so delegation never reaches for
 * session-scope state to create the execution it spawns.
 */
export type TurnExecutionHost = {
	begin: (input: BeginTurnExecutionInput) => TurnExecution;
	end: (execution: TurnExecution) => void;
	publishViewState: (
		execution: TurnExecution,
		viewState: SessionViewState
	) => void;
};
