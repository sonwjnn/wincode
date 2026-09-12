import { getSessionStore } from "../modules/sessions/storage/get-session-store";

await getSessionStore().resetSessionData();
