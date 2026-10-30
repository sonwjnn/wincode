const CONFIG_VARIABLE_PATTERN =
	/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)|\$\$|\$!/gu;

export type ConfigEnvironmentResolution =
	| Readonly<{ value: string }>
	| Readonly<{ missingVariable: string }>;

/** Expands dollar-prefixed environment references and preserves `$$` / `$!` escapes. */
export const resolveConfigEnvironmentVariables = (
	value: string,
	environment: Readonly<Record<string, string | undefined>>
): ConfigEnvironmentResolution => {
	let missingVariable: string | undefined;
	const resolved = value.replace(
		CONFIG_VARIABLE_PATTERN,
		(
			match,
			braced: string | undefined,
			envName: string | undefined,
			bare: string | undefined
		) => {
			if (match === "$$") {
				return "$";
			}
			if (match === "$!") {
				return "!";
			}
			const variable = braced ?? envName ?? bare ?? "";
			const replacement = environment[variable];
			if (replacement === undefined) {
				missingVariable ??= variable;
				return "";
			}
			return replacement;
		}
	);
	return missingVariable === undefined
		? { value: resolved }
		: { missingVariable };
};
