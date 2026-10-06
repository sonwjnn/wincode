import { isObjectLike, type LogFields, logger } from "@wincode/utils";
import { errorDiagnosticFields } from "./error-log-fields";

export type UiErrorScope = "route" | "root";

const loggedErrors = new WeakSet<object>();

/**
 * Report an error that escaped the render tree. The route boundary and the
 * root boundary can observe the same instance while a debug rethrow unwinds,
 * so each instance reaches diagnostics at most once.
 */
export const logUnhandledUiError = (
	error: unknown,
	scope: UiErrorScope,
	componentStack?: string | null
): void => {
	if (isObjectLike(error)) {
		if (loggedErrors.has(error)) {
			return;
		}
		loggedErrors.add(error);
	}
	const fields: LogFields = {
		...errorDiagnosticFields(error),
		operation: "tui",
		scope,
		...(componentStack === undefined ||
		componentStack === null ||
		componentStack === ""
			? {}
			: { componentStack }),
	};
	void logger.error("Unhandled UI error", fields);
};
