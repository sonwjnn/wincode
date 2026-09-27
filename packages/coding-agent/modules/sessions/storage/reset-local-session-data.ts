import { createDatabaseForSessionReset } from "./client";
import { createDrizzleSessionStore } from "./drizzle-session-store";

export type ResetLocalSessionDataInput = Readonly<{
	attachmentRoot: string;
	databasePath: string;
	snapshotRoot: string;
	workspaceRoot?: string;
}>;

/**
 * Explicitly clears local Session data when the normal schema reconciliation
 * cannot safely open it. Callers must opt into this destructive fallback.
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
	} finally {
		sqlite.close();
	}
};
