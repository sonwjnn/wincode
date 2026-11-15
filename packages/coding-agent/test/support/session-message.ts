import { fromPartial } from "@total-typescript/shoehorn";
import type { SessionMessage } from "@/modules/sessions/message";
import { sessionMessageId } from "./identifiers";

export const makeSessionMessage = (
	id: string,
	role: SessionMessage["role"],
	text: string
): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text, type: "text" }],
		role,
	});
