export const COPY_BEHAVIORS = ["manual", "select"] as const;

export type CopyBehavior = (typeof COPY_BEHAVIORS)[number];

export const resolveDefaultCopyBehavior = (
	platform: NodeJS.Platform
): CopyBehavior => (platform === "win32" ? "manual" : "select");

export const DEFAULT_COPY_BEHAVIOR = resolveDefaultCopyBehavior(
	process.platform
);

const COPY_BEHAVIOR_VALUES = new Set<string>(COPY_BEHAVIORS);

export const isCopyBehavior = (value: unknown): value is CopyBehavior =>
	typeof value === "string" && COPY_BEHAVIOR_VALUES.has(value);
