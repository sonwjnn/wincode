import type { Tagged } from "type-fest";

export type SessionId = Tagged<string, "SessionId">;
export type WorkspaceId = Tagged<string, "WorkspaceId">;
export type CompactionId = Tagged<string, "CompactionId">;
export type McpSnapshotId = Tagged<string, "McpSnapshotId">;
export const toSessionId = (value: string): SessionId => value as SessionId;
export const toWorkspaceId = (value: string): WorkspaceId =>
	value as WorkspaceId;
export const toCompactionId = (value: string): CompactionId =>
	value as CompactionId;
export const toMcpSnapshotId = (value: string): McpSnapshotId =>
	value as McpSnapshotId;
