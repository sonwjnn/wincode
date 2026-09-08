import { getConversationStore } from "../modules/conversations/storage/get-conversation-store";

await getConversationStore().resetConversationData();
