export type CliOptions = {
	/** Whether auto approval starts enabled (`--auto`). Off unless requested. */
	autoApproval: boolean;
	disabledPlugins: readonly string[];
};

const AUTO_APPROVAL_FLAG = "--auto";
const DISABLE_PLUGIN_OPTION = "--no-plugin";
const pluginIdentifierPattern = /^[a-z0-9_]+$/u;

/**
 * Parses runtime options from raw process arguments. Auto approval is off unless
 * `--auto` is present, matching the safe default that approvals are manual until
 * the user opts in. Plugin disablement is keyed by generic Plugin Identifier.
 */
export function parseCliOptions(argv: readonly string[]): CliOptions {
	const disabledPlugins: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined) {
			continue;
		}
		if (argument === DISABLE_PLUGIN_OPTION) {
			const pluginId = argv[index + 1];
			if (pluginId !== undefined && pluginIdentifierPattern.test(pluginId)) {
				disabledPlugins.push(pluginId);
				index += 1;
			}
			continue;
		}
		if (argument.startsWith(`${DISABLE_PLUGIN_OPTION}=`)) {
			const pluginId = argument.slice(DISABLE_PLUGIN_OPTION.length + 1);
			if (pluginIdentifierPattern.test(pluginId)) {
				disabledPlugins.push(pluginId);
			}
		}
	}
	return {
		autoApproval: argv.includes(AUTO_APPROVAL_FLAG),
		disabledPlugins: Object.freeze(disabledPlugins),
	};
}
