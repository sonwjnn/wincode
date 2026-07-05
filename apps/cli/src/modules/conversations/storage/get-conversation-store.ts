import type { ConversationStore } from "./conversation-store";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";

let cachedStore: ConversationStore | null = null;

export const getConversationStore = (): ConversationStore => {
	if (!cachedStore) {
		cachedStore = createDrizzleConversationStore();
	}

	return cachedStore;
};
