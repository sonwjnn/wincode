import { type LogFields, logger } from "@wincode/runtime-utils";
import { errorLogFields } from "./error-log-fields";

export const logSessionPersistenceFailure = (
	message: string,
	error: unknown,
	context: LogFields
): void => {
	const fields = errorLogFields(error);
	if (fields.errorCode === "session_lease_lost") {
		return;
	}
	void logger.error(message, { ...fields, ...context });
};
