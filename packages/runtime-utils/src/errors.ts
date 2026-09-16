import { isError } from "./guards";

export const getErrorMessage = (error: unknown, fallback = ""): string =>
	isError(error) ? error.message : fallback;
