import { expect, test } from "bun:test";
import { SessionBundleImportError } from "@/modules/sessions/session-bundle-import";
import { formatSessionBundleImportFailure } from "@/modules/sessions/ui/dialogs/import-session-dialog";

test("import dialog exposes stable collision codes without bundle path data", () => {
	const error = new SessionBundleImportError(
		"session_import_conflict",
		"The target Session ID already has different authoritative log content."
	);

	expect(formatSessionBundleImportFailure(error)).toBe(
		"Session bundle import failed (session_import_conflict): The target Session ID already has different authoritative log content."
	);
});
