/**
 * Runtime options parsed from the CLI process arguments. Kept intentionally
 * small: only flags that seed process-lifetime runtime state belong here.
 */
export type CliOptions = {
	/** Whether auto approval starts enabled (`--auto`). Off unless requested. */
	autoApproval: boolean;
};

const AUTO_APPROVAL_FLAG = "--auto";

/**
 * Parses runtime options from raw process arguments. Auto approval is off unless
 * `--auto` is present, matching the safe default that approvals are manual until
 * the user opts in.
 */
export function parseCliOptions(argv: readonly string[]): CliOptions {
	return {
		autoApproval: argv.includes(AUTO_APPROVAL_FLAG),
	};
}
