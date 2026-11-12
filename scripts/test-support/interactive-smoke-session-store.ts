import { createDatabase } from "../../packages/coding-agent/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../packages/coding-agent/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "../../packages/coding-agent/modules/sessions/storage/path";
import { createSessionJsonlStore } from "../../packages/coding-agent/modules/sessions/storage/session-jsonl-store";

export const openInteractiveSmokeSessionStore = (workspaceRoot: string) => {
	const operational = createDatabase();
	try {
		const databasePath = operational.sqlite.filename;
		const projection = createDatabase(
			resolveLocalSessionProjectionPath(databasePath)
		);
		try {
			const logRoot = resolveLocalSessionLogRoot(databasePath);
			const projectionStore = createDrizzleSessionStore(projection.db, {
				operationalDatabase: operational.db,
				sessionLogRoot: logRoot,
				workspaceRoot,
			});
			const store = createSessionJsonlStore(projectionStore, logRoot);
			let closed = false;
			return {
				close: () => {
					if (closed) {
						return;
					}
					closed = true;
					try {
						projection.sqlite.close();
					} finally {
						operational.sqlite.close();
					}
				},
				store,
			};
		} catch (error) {
			projection.sqlite.close();
			throw error;
		}
	} catch (error) {
		operational.sqlite.close();
		throw error;
	}
};
