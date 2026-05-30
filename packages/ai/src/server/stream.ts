import {
	createAgentUIStreamResponse,
	createIdGenerator,
	type UIMessageStreamOnFinishCallback,
} from "ai";
import type { CodingAgentUIMessage } from "../message";
import { defaultMode, type ModeType } from "../modes";
import { codingAgent } from "./agent";

type CreateCodingAgentStreamResponseOptions = {
	mode?: ModeType;
	onFinish?: UIMessageStreamOnFinishCallback<CodingAgentUIMessage>;
	sendReasoning?: boolean;
	uiMessages: CodingAgentUIMessage[];
};

export const createCodingAgentStreamResponse = ({
	mode = defaultMode.value,
	onFinish,
	sendReasoning = true,
	uiMessages,
}: CreateCodingAgentStreamResponseOptions) =>
	createAgentUIStreamResponse({
		agent: codingAgent,
		generateMessageId: createIdGenerator({
			prefix: "msg",
			size: 16,
		}),
		onFinish,
		options: { mode },
		originalMessages: uiMessages,
		sendReasoning,
		uiMessages,
	});
