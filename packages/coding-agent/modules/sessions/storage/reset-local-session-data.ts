import { createDatabaseForSessionReset } from "./client";
import { createDrizzleSessionStore } from "./drizzle-session-store";

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
	const { db, sqlite } = createDatabaseForSessionReset(databasePath);
	try {
		const store = createDrizzleSessionStore(db, {
			attachmentRoot,
			snapshotRoot,
			...(workspaceRoot === undefined ? {} : { workspaceRoot }),
		});
		await store.resetSessionData();
		const obsoleteSelectionColumns = [
			["session", "variant"],
			["session_compaction", "summarization_variant"],
		] as const;
		for (const [table, column] of obsoleteSelectionColumns) {
			const columns = sqlite
				.query(`PRAGMA table_info(${table})`)
				.all() as Array<{ name: string }>;
			if (columns.some((entry) => entry.name === column)) {
				sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
			}
		}
	} finally {
		sqlite.close();
	}
};
