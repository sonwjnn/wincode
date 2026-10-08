export type CliOptions = {
	disabledPlugins: readonly string[];
};
const DISABLE_PLUGIN_OPTION = "--no-plugin";
const pluginIdentifierPattern = /^[a-z0-9_]+$/u;

/**
 * Parses runtime Plugin options from raw process arguments. Plugin disablement
 * is keyed by generic Plugin Identifier.
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
	return { disabledPlugins: Object.freeze(disabledPlugins) };
}
