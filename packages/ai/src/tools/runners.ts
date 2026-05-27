// biome-ignore-all lint/performance/noBarrelFile: Node-only runner entry point.

import { runEditTool } from "./edit/runner";
import { runGrepTool } from "./grep/runner";
import { runListTool } from "./list/runner";
import { runReadTool } from "./read/runner";
import type {
	CodingToolInput,
	CodingToolName,
	CodingToolOutput,
} from "./schemas";
import { runWriteTool } from "./write/runner";

export { runEditTool } from "./edit/runner";
export { runGrepTool } from "./grep/runner";
export { runListTool } from "./list/runner";
export { runReadTool } from "./read/runner";
export { runWriteTool } from "./write/runner";

export type CodingToolRunnerMap = {
	[Name in CodingToolName]: (
		input: CodingToolInput<Name>
	) => Promise<CodingToolOutput<Name>>;
};

export const codingToolRunners = {
	read: runReadTool,
	write: runWriteTool,
	edit: runEditTool,
	list: runListTool,
	grep: runGrepTool,
} satisfies CodingToolRunnerMap;
