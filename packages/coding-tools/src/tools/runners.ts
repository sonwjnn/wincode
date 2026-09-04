// biome-ignore-all lint/performance/noBarrelFile: Node-only runner entry point.

import { runEditTool } from "./edit/runner";
import { runGlobTool } from "./glob/runner";
import { runGrepTool } from "./grep/runner";
import { runReadTool } from "./read/runner";
import type { ResourceLimitOptions } from "./resource-limits";
import type {
	CodingToolInput,
	CodingToolName,
	CodingToolOutput,
} from "./schemas";
import { runShellTool } from "./shell/runner";
import { runWriteTool } from "./write/runner";

export { runEditTool } from "./edit/runner";
export { runGlobTool } from "./glob/runner";
export { runGrepTool } from "./grep/runner";
export { runReadTool } from "./read/runner";
export { runShellTool } from "./shell/runner";
export { runWriteTool } from "./write/runner";
export type CodingToolRunnerOptions = ResourceLimitOptions & {
	allowExternalPath?: boolean;
};

export type CodingToolRunnerMap = {
	[Name in CodingToolName]: (
		input: CodingToolInput<Name>,
		options?: CodingToolRunnerOptions
	) => Promise<CodingToolOutput<Name>>;
};

export const codingToolRunners = {
	read: runReadTool,
	write: runWriteTool,
	edit: runEditTool,
	glob: runGlobTool,
	grep: runGrepTool,
	shell: runShellTool,
} satisfies CodingToolRunnerMap;
