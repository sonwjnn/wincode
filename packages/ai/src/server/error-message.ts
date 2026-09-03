import { normalizeModelFailure } from "../model-failures";

/** Returns a presentation-safe message for any provider/runtime failure. */
export const getProviderErrorMessage = (error: unknown): string =>
	normalizeModelFailure(error).message;
