import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadRuntime } from "../src/rpc/runtime";

test("diagnose default RPC runtime composition", async () => {
	const workspace = await mkdtemp(join("/tmp", "wincode-runtime-debug-"));
	const databasePath = join(workspace, "sessions.db");
	const previousDatabasePath = process.env.WINCODE_LOCAL_DB_PATH;
	process.env.WINCODE_LOCAL_DB_PATH = databasePath;
	try {
		const runtime = await loadRuntime();
		const assembly = await runtime.createSessionCapabilities({
			cwd: workspace,
			workspace,
		});
		await assembly.shutdown();
	} catch (error) {
		const detail =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		throw new Error(`default runtime composition failed: ${detail}`);
	} finally {
		if (previousDatabasePath === undefined) {
			delete process.env.WINCODE_LOCAL_DB_PATH;
		} else {
			process.env.WINCODE_LOCAL_DB_PATH = previousDatabasePath;
		}
		await rm(workspace, { force: true, recursive: true });
	}
});
