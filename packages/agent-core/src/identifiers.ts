import type { Tagged } from "type-fest";

export type AgentId = Tagged<string, "AgentId">;
export type AgentTurnId = Tagged<string, "AgentTurnId">;
export type ToolCallId = Tagged<string, "ToolCallId">;
export type ModelStepId = Tagged<string, "ModelStepId">;
export type SessionMessageId = Tagged<string, "SessionMessageId">;
export type SessionRecordId = Tagged<string, "SessionRecordId">;
export type AttachmentId = Tagged<string, "AttachmentId">;
export const toAgentTurnId = (value: string): AgentTurnId =>
	value as AgentTurnId;
export const toModelStepId = (value: string): ModelStepId =>
	value as ModelStepId;
export const toSessionMessageId = (value: string): SessionMessageId =>
	value as SessionMessageId;
export const toSessionRecordId = (value: string): SessionRecordId =>
	value as SessionRecordId;
