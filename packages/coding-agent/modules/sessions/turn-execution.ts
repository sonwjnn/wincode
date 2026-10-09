import {
	type AgentId,
	type AgentTurnId,
	agentTurnAssistantMessageId,
	createAgentTurnId,
	type SessionMessageId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ThinkingLevel } from "@wincode/ai/models";
import { omitUndefined } from "@wincode/utils";
import type {
	SkillExecution,
	SkillRequestContext,
	SkillToolDefinition,
} from "@/modules/skills";
import type { ResolvedCodingAgent } from "../agents/built-ins";
import type { SessionViewState } from "./hooks/runtime-turn";

/** The Skill catalog an execution armed for its own turn. */
export type TurnExecutionSkill = {
	readonly execution: SkillExecution;
	readonly tool?: SkillToolDefinition;
};

/**
 * One Agent Turn execution's turn-scoped values. The scope is created when the
 * execution starts and discarded when it ends, so no value can leak into
 * another execution.
 *
 * `armedSkill` is attached by the execution that owns it while its turn
 * starts — the Skill catalog is armed during submission preparation — and is
 * never rebuilt on render.
 */
export type TurnExecution = {
	/** The Agent the execution runs as. */
	readonly agent: AgentId;
	/** The first assistant Session Message for this execution. */
	readonly assistantId: SessionMessageId;
	/** The Model Target selection the execution runs against. */
	readonly model: ChatModelSelection;
	readonly resolvedAgent?: ResolvedCodingAgent;
	/** The session-level selection recorded on this execution's Session Records. */
	readonly sessionModel: ChatModelSelection;
	readonly sessionThinkingLevel?: ThinkingLevel;
	/** The Session Context message this execution answers. */
	readonly sourceUserMessageId: SessionMessageId | null;
	readonly startedAt: number;
	readonly turnId: AgentTurnId;
	readonly thinkingLevel?: ThinkingLevel;
	/** The Skill catalog armed for the execution's turn, when one was built. */
	armedSkill?: TurnExecutionSkill;
	/** Cleanup callbacks registered by Plugins for this Agent Turn. */
	pluginCleanups: (() => void)[];
	/** The Skill, if any, this execution's turn must load. */
	readonly skillRequest?: SkillRequestContext;
};

export type BeginTurnExecutionInput = {
	readonly agent: AgentId;
	/** The Skill catalog armed for the execution's turn, when one was built. */
	readonly armedSkill?: TurnExecutionSkill;
	readonly model: ChatModelSelection;
	readonly resolvedAgent?: ResolvedCodingAgent;
	readonly sessionModel: ChatModelSelection;
	readonly sessionThinkingLevel?: ThinkingLevel;
	/** The Skill, if any, this execution's turn must load. */
	readonly skillRequest?: SkillRequestContext;
	/** The Session Context message this execution answers, when known. */
	readonly sourceUserMessageId?: SessionMessageId;
	readonly startedAt: number;
	/** The Agent Turn Identifier; generated when the caller has none yet. */
	readonly turnId?: AgentTurnId;
	readonly thinkingLevel?: ThinkingLevel;
};

export const createTurnExecution = ({
	agent,
	armedSkill,
	model,
	resolvedAgent,
	sessionModel,
	sessionThinkingLevel,
	skillRequest,
	sourceUserMessageId,
	startedAt,
	turnId: providedTurnId,
	thinkingLevel,
}: BeginTurnExecutionInput): TurnExecution => {
	const turnId = providedTurnId ?? createAgentTurnId();
	return {
		agent,
		...omitUndefined({
			armedSkill,
			resolvedAgent,
			sessionThinkingLevel,
			skillRequest,
			thinkingLevel,
		}),
		assistantId: agentTurnAssistantMessageId(turnId),
		pluginCleanups: [],
		model,
		sessionModel,
		sourceUserMessageId: sourceUserMessageId ?? null,
		startedAt,
		turnId,
	};
};

/**
 * Starts, ends, and publishes the Session View State of Agent Turn
 * executions. The binding supplies it, so each execution stays independent.
 */
export type TurnExecutionHost = {
	begin: (input: BeginTurnExecutionInput) => TurnExecution;
	end: (execution: TurnExecution) => void;
	publishViewState: (
		execution: TurnExecution,
		viewState: SessionViewState
	) => void;
};
