/**
 * Snapshots the named environment variables and returns the restore that hands
 * them back, so a test file that overrides them cannot leak into a sibling.
 */
export const createEnvironmentRestorer = (
	keys: readonly string[]
): (() => void) => {
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
};
