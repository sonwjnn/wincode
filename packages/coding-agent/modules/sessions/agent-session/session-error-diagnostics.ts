import type { LogFields } from "@wincode/utils";
import { errorLogFields } from "@/shared/utils/error-log-fields";
import { isExpectedCompactionError } from "../compaction/error";

export const getReportableSessionFailureFields = (
	error: unknown,
	fields: LogFields = errorLogFields(error),
	errorCode = fields.errorCode
): LogFields | null =>
	errorCode !== "cancelled" &&
	errorCode !== "ENOENT" &&
	fields.errorType !== "SessionClosedError" &&
	fields.errorType !== "SessionSendCancelledError" &&
	fields.errorType !== "AbortError" &&
	!isExpectedCompactionError(error)
		? fields
		: null;
