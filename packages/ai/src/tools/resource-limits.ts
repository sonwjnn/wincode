import { z } from "zod";

export const RESOURCE_LIMIT_PROFILES = [
	"standard",
	"extended",
	"deep",
] as const;

export type ResourceLimitProfile = (typeof RESOURCE_LIMIT_PROFILES)[number];

export const resourceLimitProfileSchema = z.enum(RESOURCE_LIMIT_PROFILES);
export const DEFAULT_RESOURCE_LIMIT_PROFILE = "standard" as const;
export const RESOURCE_LIMIT_PERMISSION_ACTION = "resource_limits" as const;

export type ToolResourceLimits = {
	readonly profile: ResourceLimitProfile;
	readonly read: {
		readonly maxOutputBytes: number;
		readonly maxDirectoryOutputBytes: number;
	};
	readonly list: {
		readonly maxDepth: number;
		readonly maxEntries: number;
		readonly maxOutputBytes: number;
	};
	readonly glob: {
		readonly maxCandidates: number;
		readonly maxDurationMs: number;
		readonly maxOutputBytes: number;
	};
	readonly grep: {
		readonly maxDepth: number;
		readonly maxFileBytes: number;
		readonly maxFiles: number;
		readonly maxLineBytes: number;
		readonly maxMatches: number;
		readonly maxOutputBytes: number;
		readonly maxDurationMs: number;
	};
	readonly shell: {
		readonly defaultTimeoutSeconds: number;
		readonly maxTimeoutSeconds: number;
		readonly maxCommandChars: number;
		readonly maxCwdChars: number;
		readonly maxOutputBytes: number;
	};
	readonly edit: {
		readonly maxDiffBytes: number;
		readonly maxDiffLines: number;
	};
};
export type ResourceLimitOptions = {
	readonly resourceLimits?: ToolResourceLimits;
};

export const TOOL_RESOURCE_LIMITS = {
	standard: {
		edit: {
			maxDiffBytes: 256 * 1024,
			maxDiffLines: 2000,
		},
		grep: {
			maxDepth: 5,
			maxDurationMs: 30_000,
			maxFileBytes: 1_000_000,
			maxFiles: 1000,
			maxLineBytes: 1000,
			maxMatches: 1000,
			maxOutputBytes: 6000,
		},
		list: {
			maxDepth: 5,
			maxEntries: 10_000,
			maxOutputBytes: 4000,
		},
		glob: {
			maxCandidates: 10_000,
			maxDurationMs: 5000,
			maxOutputBytes: 16 * 1024,
		},
		profile: "standard",
		read: {
			maxDirectoryOutputBytes: 50 * 1024,
			maxOutputBytes: 6000,
		},
		shell: {
			defaultTimeoutSeconds: 30,
			maxCommandChars: 4096,
			maxCwdChars: 1024,
			maxOutputBytes: 30 * 1024,
			maxTimeoutSeconds: 300,
		},
	},
	extended: {
		edit: {
			maxDiffBytes: 1024 * 1024,
			maxDiffLines: 10_000,
		},
		grep: {
			maxDepth: 12,
			maxDurationMs: 60_000,
			maxFileBytes: 10 * 1024 * 1024,
			maxFiles: 5000,
			maxLineBytes: 4000,
			maxMatches: 5000,
			maxOutputBytes: 32 * 1024,
		},
		list: {
			maxDepth: 10,
			maxEntries: 50_000,
			maxOutputBytes: 16 * 1024,
		},
		glob: {
			maxCandidates: 10_000,
			maxDurationMs: 5000,
			maxOutputBytes: 32 * 1024,
		},
		profile: "extended",
		read: {
			maxDirectoryOutputBytes: 128 * 1024,
			maxOutputBytes: 128 * 1024,
		},
		shell: {
			defaultTimeoutSeconds: 60,
			maxCommandChars: 8192,
			maxCwdChars: 2048,
			maxOutputBytes: 64 * 1024,
			maxTimeoutSeconds: 600,
		},
	},
	deep: {
		edit: {
			maxDiffBytes: 4 * 1024 * 1024,
			maxDiffLines: 50_000,
		},
		grep: {
			maxDepth: 32,
			maxDurationMs: 120_000,
			maxFileBytes: 50 * 1024 * 1024,
			maxFiles: 20_000,
			maxLineBytes: 16_000,
			maxMatches: 20_000,
			maxOutputBytes: 128 * 1024,
		},
		list: {
			maxDepth: 32,
			maxEntries: 200_000,
			maxOutputBytes: 64 * 1024,
		},
		glob: {
			maxCandidates: 10_000,
			maxDurationMs: 5000,
			maxOutputBytes: 128 * 1024,
		},
		profile: "deep",
		read: {
			maxDirectoryOutputBytes: 512 * 1024,
			maxOutputBytes: 512 * 1024,
		},
		shell: {
			defaultTimeoutSeconds: 120,
			maxCommandChars: 16_384,
			maxCwdChars: 4096,
			maxOutputBytes: 128 * 1024,
			maxTimeoutSeconds: 900,
		},
	},
} as const satisfies Record<ResourceLimitProfile, ToolResourceLimits>;

export const getToolResourceLimits = (
	profile: ResourceLimitProfile = DEFAULT_RESOURCE_LIMIT_PROFILE
): ToolResourceLimits => TOOL_RESOURCE_LIMITS[profile];

export const isElevatedResourceProfile = (
	profile: ResourceLimitProfile
): boolean => profile !== DEFAULT_RESOURCE_LIMIT_PROFILE;
