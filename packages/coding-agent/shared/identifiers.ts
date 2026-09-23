import type { Tagged } from "type-fest";

export type SessionId = Tagged<string, "SessionId">;
export type WorkspaceId = Tagged<string, "WorkspaceId">;
export type CompactionId = Tagged<string, "CompactionId">;
export type McpSnapshotId = Tagged<string, "McpSnapshotId">;
export type SubmissionId = Tagged<string, "SubmissionId">;
export type QueuedSubmissionId = Tagged<string, "QueuedSubmissionId">;
export type SteeringMessageId = Tagged<string, "SteeringMessageId">;
export const toSessionId = (value: string): SessionId => value as SessionId;
export const toWorkspaceId = (value: string): WorkspaceId =>
	value as WorkspaceId;
export const toCompactionId = (value: string): CompactionId =>
	value as CompactionId;
export const toMcpSnapshotId = (value: string): McpSnapshotId =>
	value as McpSnapshotId;
export const toSubmissionId = (value: string): SubmissionId =>
	value as SubmissionId;
export const toQueuedSubmissionId = (value: string): QueuedSubmissionId =>
	value as QueuedSubmissionId;
export const toSteeringMessageId = (value: string): SteeringMessageId =>
	value as SteeringMessageId;
