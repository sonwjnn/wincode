import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLocalSessionProjectionPath } from "@/modules/sessions/storage/path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-session-path-"));

afterAll(async () => {
	await fs.rm(root, { force: true, recursive: true });
});

test("an in-memory Session database resolves its projection in memory instead of the working directory", () => {
	// A non-file database has no directory to hold a projection, and deriving one
	// from `:memory:` puts the file beside whatever directory the process runs in.
	expect(resolveLocalSessionProjectionPath(":memory:")).toBe(":memory:");
});

test("a file Session database resolves its projection beside the database", () => {
	const databasePath = path.join(root, "sessions.db");

	expect(resolveLocalSessionProjectionPath(databasePath)).toBe(
		path.join(root, "session-projection.sqlite")
	);
});
