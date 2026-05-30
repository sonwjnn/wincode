import type { UIMessage } from "ai";
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

export type CodingMessageMetadata = { mode?: ModeType };

export type CodingAgentUIMessage = UIMessage<
	CodingMessageMetadata,
	never,
	CodingAgentTools
>;
