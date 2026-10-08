import type {
	AgentId,
	AgentTurnId,
	SessionMessageId,
	ToolCallId,
} from "@wincode/agent-core";
import type { SessionId } from "@wincode/coding-agent";

export const agentId = (value: string): AgentId => value as AgentId;
export const agentTurnId = (value: string): AgentTurnId => value as AgentTurnId;
export const sessionId = (value: string): SessionId => value as SessionId;
export const sessionMessageId = (value: string): SessionMessageId =>
	value as SessionMessageId;
export const toolCallId = (value: string): ToolCallId => value as ToolCallId;
