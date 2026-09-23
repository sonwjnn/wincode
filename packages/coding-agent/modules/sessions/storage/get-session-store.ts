import { createDrizzleSessionStore } from "./drizzle-session-store";
import type { SessionStore } from "./session-store";

let cachedStore: SessionStore | null = null;

export const getSessionStore = (): SessionStore => {
	if (!cachedStore) {
		cachedStore = createDrizzleSessionStore();
	}

	return cachedStore;
};
