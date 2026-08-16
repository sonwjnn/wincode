import type { UIMessage } from "ai";
import type { CodingAgentDataParts } from "./file-mentions";
import type { CodingMessageMetadata } from "./metadata";
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
} & {
	__dynamic: {
		input: unknown;
		output: unknown;
	};
};

export type CodingAgentUIMessage = UIMessage<
	CodingMessageMetadata,
	CodingAgentDataParts,
	CodingAgentTools
>;
