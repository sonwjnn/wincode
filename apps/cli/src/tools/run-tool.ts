import {
	bashInputSchema,
	editInputSchema,
	grepInputSchema,
	listInputSchema,
	readInputSchema,
	writeInputSchema,
} from "@wincode/tools";
import { runBashTool } from "./bash";
import { runEditTool } from "./edit";
import { runGrepTool } from "./grep";
import { runListTool } from "./list";
import { runReadTool } from "./read";
import { runWriteTool } from "./write";

export const runTool = (toolName: string, input: unknown) => {
	switch (toolName) {
		case "list":
			return runListTool(listInputSchema.parse(input));
		case "grep":
			return runGrepTool(grepInputSchema.parse(input));
		case "read":
			return runReadTool(readInputSchema.parse(input));
		case "write":
			return runWriteTool(writeInputSchema.parse(input));
		case "edit":
			return runEditTool(editInputSchema.parse(input));
		case "bash":
			return runBashTool(bashInputSchema.parse(input));
		default:
			throw new Error(`Unknown tool: ${toolName}`);
	}
};
