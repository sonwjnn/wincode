import type { Tagged } from "type-fest";

export type SessionId = Tagged<string, "SessionId">;
export type SessionHistoryEntryId = Tagged<string, "SessionHistoryEntryId">;
export type SessionUsageEntryId = Tagged<string, "SessionUsageEntryId">;
export type WorkspaceId = Tagged<string, "WorkspaceId">;
export type CompactionId = Tagged<string, "CompactionId">;
export type QueuedSubmissionId = Tagged<string, "QueuedSubmissionId">;
export type SteeringMessageId = Tagged<string, "SteeringMessageId">;
export const SESSION_IDENTIFIER_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/u;
export const isValidSessionId = (value: string): value is SessionId =>
	SESSION_IDENTIFIER_PATTERN.test(value);
export const isValidSessionHistoryEntryId = (
	value: string
): value is SessionHistoryEntryId => SESSION_IDENTIFIER_PATTERN.test(value);
export const toSessionId = (value: string): SessionId => value as SessionId;
export const toSessionHistoryEntryId = (
	value: string
): SessionHistoryEntryId => {
	if (!isValidSessionHistoryEntryId(value)) {
		throw new Error("Session history entry ID is invalid.");
	}
	return value;
};
export const toSessionUsageEntryId = (value: string): SessionUsageEntryId =>
	value as SessionUsageEntryId;
export const toWorkspaceId = (value: string): WorkspaceId =>
	value as WorkspaceId;
export const toCompactionId = (value: string): CompactionId =>
	value as CompactionId;
export const toQueuedSubmissionId = (value: string): QueuedSubmissionId =>
	value as QueuedSubmissionId;
export const toSteeringMessageId = (value: string): SteeringMessageId =>
	value as SteeringMessageId;
