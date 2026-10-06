import type { Tagged } from "type-fest";

export type McpSnapshotId = Tagged<string, "McpSnapshotId">;

export const toMcpSnapshotId = (value: string): McpSnapshotId =>
	value as McpSnapshotId;
