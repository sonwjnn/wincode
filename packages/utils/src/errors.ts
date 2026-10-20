import { isError } from "./guards.ts";

export const getErrorMessage = (error: unknown, fallback = ""): string =>
	isError(error) ? error.message : fallback;
