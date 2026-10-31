import { createDatabase } from "./client";
import { createDrizzleSessionStore } from "./drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "./path";
import { createSessionJsonlStore } from "./session-jsonl-store";
import type { SessionStore } from "./session-store";

let cachedStore: SessionStore | null = null;

export const getSessionStore = (): SessionStore => {
	if (!cachedStore) {
		const operationalDatabase = createDatabase();
		const projectionDatabase = createDatabase(
			resolveLocalSessionProjectionPath(operationalDatabase.sqlite.filename)
		);
		const projectionStore = createDrizzleSessionStore(projectionDatabase.db, {
			operationalDatabase: operationalDatabase.db,
			sessionLogRoot: resolveLocalSessionLogRoot(
				operationalDatabase.sqlite.filename
			),
		});
		cachedStore = createSessionJsonlStore(
			projectionStore,
			resolveLocalSessionLogRoot(operationalDatabase.sqlite.filename)
		);
	}

	return cachedStore;
};
