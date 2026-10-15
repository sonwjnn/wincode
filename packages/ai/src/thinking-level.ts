import { z } from "zod";

/** Stable reasoning levels Wincode can persist and send. */
export const thinkingLevelIds = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ThinkingLevel = (typeof thinkingLevelIds)[number];
export type ThinkingLevelMap = Readonly<
	Partial<Record<ThinkingLevel, string | null>>
>;

export const thinkingLevelSchema = z.enum(thinkingLevelIds);

export type ThinkingSelection = Readonly<{
	thinkingLevel?: ThinkingLevel;
}>;
