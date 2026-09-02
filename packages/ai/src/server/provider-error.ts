import { isModelContextOverflowError } from "../model-failures";

export type ProviderErrorKind = "context-overflow" | "other";

export const classifyProviderError = (error: unknown): ProviderErrorKind =>
	isModelContextOverflowError(error) ? "context-overflow" : "other";
