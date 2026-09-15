import type { UnknownRecord } from "type-fest";
/** Narrows an unknown remote value to a non-array string-keyed record. */
export const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);
