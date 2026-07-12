import type { UIMessage } from "ai";
import type { CodingAgentDataParts } from "./file-mentions";
import type { ChatModelSelection, SupportedChatModelId } from "./models";
import type { ModeType } from "./modes";
import type {
	CodingToolInput,
	CodingToolName,
	CodingToolOutput,
} from "./tools/schemas";

export type CodingAgentTools = {
	[Name in CodingToolName]: {
		input: CodingToolInput<Name>;
		output: CodingToolOutput<Name>;
	};
};

export type CodingMessageMetadata = {
	mode?: ModeType;
	model?: SupportedChatModelId | ChatModelSelection;
	interrupted?: boolean;
	responseTimeMs?: number;
};

export type CodingAgentUIMessage = UIMessage<
	CodingMessageMetadata,
	CodingAgentDataParts,
	CodingAgentTools
>;
