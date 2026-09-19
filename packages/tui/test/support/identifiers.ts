import {
	type AgentId,
	type AgentTurnId,
	type AttachmentId,
	agentIdSchema,
	type ModelStepId,
	type SessionMessageId,
	type SessionRecordId,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import type { ModelId, SupportedChatModelId } from "@wincode/ai/models";
import type {
	CompactionId,
	McpSnapshotId,
	QueuedSubmissionId,
	SessionId,
	SteeringMessageId,
} from "@/shared/identifiers";

export const agentId = <const Value extends string>(
	value: Value
): Value & AgentId => agentIdSchema.parse(value) as Value & AgentId;

export const agentTurnId = <const Value extends string>(
	value: Value
): Value & AgentTurnId => value as Value & AgentTurnId;

export const attachmentId = <const Value extends string>(
	value: Value
): Value & AttachmentId => value as Value & AttachmentId;

export const compactionId = <const Value extends string>(
	value: Value
): Value & CompactionId => value as Value & CompactionId;

export const modelId = <const Value extends string>(
	value: Value
): Value & SupportedChatModelId => value as Value & SupportedChatModelId;
export const modelIdentity = <const Value extends string>(
	value: Value
): Value & ModelId => value as Value & ModelId;

export const modelStepId = <const Value extends string>(
	value: Value
): Value & ModelStepId => value as Value & ModelStepId;

export const mcpSnapshotId = <const Value extends string>(
	value: Value
): Value & McpSnapshotId => value as Value & McpSnapshotId;

export const queuedSubmissionId = <const Value extends string>(
	value: Value
): Value & QueuedSubmissionId => value as Value & QueuedSubmissionId;

export const sessionId = <const Value extends string>(
	value: Value
): Value & SessionId => value as Value & SessionId;

export const sessionMessageId = <const Value extends string>(
	value: Value
): Value & SessionMessageId =>
	toSessionMessageId(value) as Value & SessionMessageId;

export const sessionRecordId = <const Value extends string>(
	value: Value
): Value & SessionRecordId => value as Value & SessionRecordId;

export const steeringMessageId = <const Value extends string>(
	value: Value
): Value & SteeringMessageId => value as Value & SteeringMessageId;

export const toolCallId = <const Value extends string>(
	value: Value
): Value & ToolCallId => value as Value & ToolCallId;
