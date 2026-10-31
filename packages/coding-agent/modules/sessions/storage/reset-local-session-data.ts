import { createDatabaseForSessionReset } from "./client";
import { createDrizzleSessionStore } from "./drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "./path";
import { createSessionJsonlStore } from "./session-jsonl-store";

export type ResetLocalSessionDataInput = Readonly<{
	attachmentRoot: string;
	databasePath: string;
	snapshotRoot: string;
	workspaceRoot?: string;
}>;

/**
 * Clears local Session records and attachments when their schema is incompatible.
 */
export const resetLocalSessionData = async ({
	attachmentRoot,
	databasePath,
	snapshotRoot,
	workspaceRoot,
}: ResetLocalSessionDataInput): Promise<void> => {
	const operational = createDatabaseForSessionReset(databasePath);
	try {
		const projection = createDatabaseForSessionReset(
			resolveLocalSessionProjectionPath(databasePath)
		);
		try {
			const logRoot = resolveLocalSessionLogRoot(databasePath);
			const projectionStore = createDrizzleSessionStore(projection.db, {
				attachmentRoot,
				operationalDatabase: operational.db,
				sessionLogRoot: logRoot,
				snapshotRoot,
				...(workspaceRoot === undefined ? {} : { workspaceRoot }),
			});
			const store = createSessionJsonlStore(projectionStore, logRoot);
			await store.resetSessionData();
			const obsoleteSelectionColumns = [
				["session", "variant"],
				["session_compaction", "summarization_variant"],
			] as const;
			for (const [table, column] of obsoleteSelectionColumns) {
				const columns = projection.sqlite
					.query(`PRAGMA table_info(${table})`)
					.all() as Array<{ name: string }>;
				if (columns.some((entry) => entry.name === column)) {
					projection.sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
				}
			}
		} finally {
			projection.sqlite.close();
		}
	} finally {
		operational.sqlite.close();
	}
};
