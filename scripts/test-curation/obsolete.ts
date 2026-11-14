/**
 * Obsolete-test detector: a Default test file whose relative imports do not
 * resolve is testing a path that no longer exists.
 *
 *   bun scripts/test-curation/obsolete.ts
 *
 * Writes `<artifacts>/analysis/obsolete.json`. Hits need a manual read: virtual
 * module ids used with `mock.module` and fixtures written into temporary
 * workspaces also look unresolved.
 */
import * as path from "node:path";
import {
	analysisDir,
	defaultTestFiles,
	ensureArtifacts,
	isReadableFile,
	repoRoot,
	writeJson,
} from "./lib";

const ROOT = repoRoot();
const files = defaultTestFiles().map((entry) => entry.path);
const extensions = [
	"",
	".ts",
	".tsx",
	".js",
	".jsx",
	"/index.ts",
	"/index.tsx",
];

const resolves = async (base: string): Promise<boolean> => {
	for (const extension of extensions) {
		if (await isReadableFile(path.join(ROOT, base + extension))) {
			return true;
		}
	}
	return false;
};

const importPattern = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
const unresolved = new Map<string, Set<string>>();
for (const file of files) {
	const source = await Bun.file(path.join(ROOT, file)).text();
	for (const match of source.matchAll(importPattern)) {
		const specifier = match[1];
		if (specifier === undefined) {
			continue;
		}
		const base = path.posix.join(path.posix.dirname(file), specifier);
		if (await resolves(base)) {
			continue;
		}
		unresolved.set(file, (unresolved.get(file) ?? new Set()).add(specifier));
	}
}

await ensureArtifacts();
await writeJson(path.join(analysisDir(), "obsolete.json"), {
	filesWithUnresolvedImports: [...unresolved.entries()].map(
		([file, specifiers]) => ({ file, specifiers: [...specifiers] })
	),
	scannedFiles: files.length,
});
console.log(
	JSON.stringify(
		{
			examples: [...unresolved.entries()].slice(0, 10),
			filesWithUnresolvedImports: unresolved.size,
			scannedFiles: files.length,
		},
		null,
		2
	)
);
