import * as fs from "node:fs";
import * as path from "node:path";
import {
	isArray,
	isNonEmptyString,
	isPlainObject,
	isUndefined,
} from "@wincode/utils";
import {
	isTrustedProjectRoot,
	PROJECT_COMMAND_ROOT,
} from "@/modules/project-trust/project-resource-roots";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { resolveConfigRelativePath } from "@/shared/config/resolve-config-relative-path";
import { getProjectRoots } from "@/shared/paths/project-roots";
import type { CustomCommandCandidate } from "./types";

const MARKDOWN_EXTENSION = ".md";

export type CustomCommandDiscoveryInput = {
	homeRoot: string;
	snapshot: ConfigSnapshot;
	trustedProjectRoots?: readonly string[];
	workspace: string;
};

function collect(
	base: string,
	scope: CustomCommandCandidate["scope"]
): CustomCommandCandidate[] {
	if (!(fs.existsSync(base) && fs.statSync(base).isDirectory())) {
		return [];
	}
	return fs
		.readdirSync(base, { withFileTypes: true })
		.filter(
			(entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)
		)
		.map((entry) => ({ filePath: path.join(base, entry.name), scope }));
}

const configuredRoots = (snapshot: ConfigSnapshot) => {
	const commands = snapshot.document.commands;
	if (
		!(isPlainObject(commands) && "paths" in commands && isArray(commands.paths))
	) {
		return [];
	}
	return commands.paths.flatMap((configuredPath, index) => {
		if (!isNonEmptyString(configuredPath)) {
			return [];
		}
		const resolved = resolveConfigRelativePath(
			snapshot,
			["commands", "paths", String(index)],
			configuredPath
		);
		return isUndefined(resolved) ? [] : [resolved];
	});
};

export function discoverCustomCommandCandidates(
	input: CustomCommandDiscoveryInput
): CustomCommandCandidate[] {
	const configured = configuredRoots(input.snapshot);
	const result = collect(
		path.join(input.homeRoot, PROJECT_COMMAND_ROOT),
		"global"
	);
	for (const root of configured) {
		if (root.scope === "global") {
			result.push(...collect(root.path, root.scope));
		}
	}
	for (const root of getProjectRoots(input.workspace)) {
		if (!isTrustedProjectRoot(root, input.trustedProjectRoots)) {
			continue;
		}
		result.push(...collect(path.join(root, PROJECT_COMMAND_ROOT), "project"));
	}
	for (const root of configured) {
		if (root.scope === "project") {
			result.push(...collect(root.path, root.scope));
		}
	}
	return result;
}
