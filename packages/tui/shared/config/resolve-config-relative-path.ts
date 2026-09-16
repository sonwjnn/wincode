import { dirname, resolve } from "node:path";
import { isUndefined } from "@wincode/runtime-utils";
import type { ConfigScope, ConfigSnapshot } from "./config-store";

export type ResolvedConfigPath = {
	path: string;
	scope: ConfigScope;
};

export const resolveConfigRelativePath = (
	snapshot: ConfigSnapshot,
	fieldPath: readonly string[],
	configuredPath: string
): ResolvedConfigPath | undefined => {
	const origin = snapshot.sourceFor(fieldPath);
	if (isUndefined(origin)) {
		return;
	}
	return {
		path: resolve(dirname(origin.path), configuredPath),
		scope: origin.scope,
	};
};
