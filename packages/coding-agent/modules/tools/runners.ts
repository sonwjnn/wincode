// biome-ignore-all lint/performance/noBarrelFile: Node-only runner entry point.

import type { ResourceLimitOptions } from "./resource-limits";
import type { VersionedEditingContext } from "./versioned/contracts";

export { runEditTool } from "./edit/runner";
export { runGlobTool } from "./glob/runner";
export { runGrepTool } from "./grep/runner";
export { runReadTool } from "./read/runner";
export { runRecoverTool } from "./recover/runner";
export { runShellTool } from "./shell/runner";
export { runWriteTool } from "./write/runner";

export type CodingToolRunnerOptions = ResourceLimitOptions & {
	allowCrossSession?: boolean;
	allowExternalPath?: boolean;
	allowSloppy?: boolean;
	signal?: AbortSignal;
	versionedEditing?: VersionedEditingContext;
};
