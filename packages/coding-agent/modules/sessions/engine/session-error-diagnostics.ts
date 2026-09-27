import type { LogFields } from "@wincode/runtime-utils";
import { errorLogFields } from "@/shared/utils/error-log-fields";
import { isExpectedCompactionError } from "../compaction/error";

export const getReportableSessionFailureFields = (
	error: unknown,
	fields: LogFields = errorLogFields(error),
	errorCode = fields.errorCode
): LogFields | null =>
	errorCode !== "cancelled" &&
	errorCode !== "session_lease_lost" &&
	errorCode !== "ENOENT" &&
	fields.errorType !== "SessionClosedError" &&
	fields.errorType !== "SessionSendCancelledError" &&
	fields.errorType !== "AbortError" &&
	!isExpectedCompactionError(error)
		? fields
		: null;
