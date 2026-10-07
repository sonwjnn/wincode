/**
 * Runtime options parsed from the CLI process arguments. Kept intentionally
 * small: only flags that seed process-lifetime runtime state belong here.
 */
export type OptionalPluginId = "mcp" | "subagents";

export type CliOptions = {
	/** Whether auto approval starts enabled (`--auto`). Off unless requested. */
	autoApproval: boolean;
	disabledPlugins: readonly OptionalPluginId[];
};

const AUTO_APPROVAL_FLAG = "--auto";
const optionalPlugins = ["mcp", "subagents"] as const;
const OPTIONAL_PLUGIN_FLAGS: Readonly<Record<OptionalPluginId, string>> = {
	mcp: "--no-mcp",
	subagents: "--no-subagents",
};

/**
 * Parses runtime options from raw process arguments. Auto approval is off unless
 * `--auto` is present, matching the safe default that approvals are manual until
 * the user opts in.
 */
export function parseCliOptions(argv: readonly string[]): CliOptions {
	return {
		autoApproval: argv.includes(AUTO_APPROVAL_FLAG),
		disabledPlugins: optionalPlugins.filter((pluginId) =>
			argv.includes(OPTIONAL_PLUGIN_FLAGS[pluginId])
		),
	};
}
