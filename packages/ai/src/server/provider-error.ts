import { isModelContextOverflowError } from "../model-failures";

export type ProviderErrorKind = "context-overflow" | "other";

/** Legacy adapter retained while callers move to the focused failure contract. */
export const isContextOverflowError = isModelContextOverflowError;

export const classifyProviderError = (error: unknown): ProviderErrorKind =>
	isContextOverflowError(error) ? "context-overflow" : "other";
