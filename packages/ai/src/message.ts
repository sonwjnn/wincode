import type { UIMessage } from "ai";
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

export type CodingAgentUIMessage = UIMessage<unknown, never, CodingAgentTools>;
