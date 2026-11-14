import { createDatabase } from "./client";
import { createDrizzleSessionStore } from "./drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "./path";
import type { PromptHistory } from "./prompt-history";
import type { SessionAttachments } from "./session-attachments";
import type { SessionCatalog } from "./session-catalog";
import type { SessionHistory } from "./session-history";
import { createSessionJsonlStore } from "./session-jsonl-store";
import type { SessionLifecycle } from "./session-lifecycle";
import type { SessionRecords } from "./session-records";
import type { SessionStorage } from "./session-storage";

type CachedStorage = Readonly<{
	promptHistory: PromptHistory;
	storage: SessionStorage;
}>;

let cachedStores: CachedStorage | null = null;

const openStores = (): CachedStorage => {
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
	return {
		promptHistory: projectionStore.promptHistory,
		storage: createSessionJsonlStore(
			projectionStore,
			resolveLocalSessionLogRoot(operationalDatabase.sqlite.filename)
		),
	};
};

/**
 * The six Session facets this process shares, resolved once. Composition roots
 * hold this merged value; a consumer imports the facet accessor below instead.
 */
export const getSessionStorage = (): SessionStorage => {
	cachedStores ??= openStores();
	return cachedStores.storage;
};

/**
 * The facets below are narrowed views of the one shared value, so a consumer
 * declares the single facet it reads instead of receiving the whole surface.
 */
export const getSessionRecords = (): SessionRecords => getSessionStorage();
export const getSessionCatalog = (): SessionCatalog => getSessionStorage();
export const getSessionHistory = (): SessionHistory => getSessionStorage();
export const getSessionLifecycle = (): SessionLifecycle => getSessionStorage();
export const getSessionAttachments = (): SessionAttachments =>
	getSessionStorage();

/**
 * Workspace prompt history shares the Session connection without being a Session
 * facet, so it is resolved beside the facets rather than through them. A caller
 * that also has to externalize a prompt's file parts composes that from
 * `getSessionAttachments()`, which keeps this handle workspace state alone.
 */
export const getPromptHistoryStore = (): PromptHistory => {
	cachedStores ??= openStores();
	return cachedStores.promptHistory;
};
