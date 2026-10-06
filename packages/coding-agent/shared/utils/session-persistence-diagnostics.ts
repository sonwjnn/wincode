import { type LogFields, logger } from "@wincode/utils";
import { errorLogFields } from "./error-log-fields";

export const logSessionPersistenceFailure = (
	message: string,
	error: unknown,
	context: LogFields
): void => {
	const fields = errorLogFields(error);
	void logger.error(message, { ...fields, ...context });
};
