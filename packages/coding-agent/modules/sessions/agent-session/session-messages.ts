/**
 * The message a Session answers with once it has ended. It is user-visible and
 * asserted by tests, so it lives here rather than being repeated in each
 * workflow that reports it.
 */
export const SESSION_SHUT_DOWN_ERROR = "The session has ended.";
export const SESSION_PROJECTION_BLOCKED_ERROR =
	"Session work is paused because its SQLite projection is unavailable. Close and reopen it after storage recovers.";
