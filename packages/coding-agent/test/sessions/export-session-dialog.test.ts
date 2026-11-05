import { expect, test } from "bun:test";
import { SessionBundleExportError } from "@/modules/sessions/session-bundle-export";
import { formatSessionBundleExportFailure } from "@/modules/sessions/ui/dialogs/export-session-dialog";
import { toSessionId } from "@/shared/identifiers";

test("export dialog includes Session, sequence, and byte offset for corrupt logs", () => {
	const sessionId = toSessionId("dialog-corrupt-export");
	const failure = new SessionBundleExportError(
		"session_log_corrupt",
		sessionId,
		"Session log contains an invalid complete JSON line.",
		{ offset: 84, reason: "invalid complete JSON", sequence: 3 }
	);

	expect(formatSessionBundleExportFailure(failure)).toBe(
		"Session log contains an invalid complete JSON line. (Session dialog-corrupt-export; sequence 3; byte offset 84)"
	);
});

test("export dialog marks unavailable corrupt-log positions as unknown", () => {
	const failure = new SessionBundleExportError(
		"session_log_version_unsupported",
		toSessionId("dialog-unsupported-export"),
		"Session log format version is not supported."
	);

	expect(formatSessionBundleExportFailure(failure)).toContain(
		"sequence unknown; byte offset unknown"
	);
});
