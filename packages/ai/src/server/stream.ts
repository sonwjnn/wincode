import {
	createAgentUIStreamResponse,
	createIdGenerator,
	type UIMessageStreamOnFinishCallback,
} from "ai";
import type { CodingAgentUIMessage } from "../message";
import { codingAgent } from "./agent";

type CreateCodingAgentStreamResponseOptions = {
	onFinish?: UIMessageStreamOnFinishCallback<CodingAgentUIMessage>;
	sendReasoning?: boolean;
	uiMessages: CodingAgentUIMessage[];
};

export const createCodingAgentStreamResponse = ({
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
		originalMessages: uiMessages,
		sendReasoning,
		uiMessages,
	});
