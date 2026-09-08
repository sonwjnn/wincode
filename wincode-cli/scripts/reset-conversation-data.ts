import { getConversationStore } from "../src/modules/conversations/storage/get-conversation-store";

await getConversationStore().resetConversationData();
