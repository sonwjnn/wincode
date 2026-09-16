import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * ADR-0019 says a non-TUI host can reuse the Session Engine, which only holds
 * while the Engine's module graph stays free of React and the terminal
 * renderers. Lint catches direct imports; this walks the graph transitively, so
 * a barrel (or a barrel behind a barrel) cannot smuggle React back in.
 */
const TUI_ROOT = resolve(import.meta.dir, "../..");
const ENGINE_ENTRY = resolve(
	TUI_ROOT,
	"modules/sessions/engine/session-engine.ts"
);
const FORBIDDEN_MODULE_ROOTS = new Set(["react", "react-dom", "@opentui"]);
const MODULE_EDGE_PATTERN =
	/(?:^|\n)(?!\s*(?:import|export)\s+type\b)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/gu;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

const walkEngineGraph = (
	entry: string
): { readonly offenders: string[]; readonly unresolved: string[] } => {
	const offenders: string[] = [];
	const unresolved: string[] = [];
	const visited = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || visited.has(file)) {
			continue;
		}
		visited.add(file);
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(MODULE_EDGE_PATTERN)) {
			const specifier = match[1];
			if (specifier === undefined) {
				continue;
			}
			const segments = specifier.split("/");
			const moduleRoot = specifier.startsWith("@")
				? segments.slice(0, 2).join("/")
				: (segments[0] ?? "");
			if (FORBIDDEN_MODULE_ROOTS.has(moduleRoot)) {
				offenders.push(`${file} -> ${specifier}`);
				continue;
			}
			// Bare specifiers are workspace packages and node built-ins: they sit
			// outside this package's graph.
			let base: string | null = null;
			if (specifier.startsWith("@/")) {
				base = resolve(TUI_ROOT, specifier.slice(2));
			} else if (specifier.startsWith(".")) {
				base = resolve(dirname(file), specifier);
			}
			if (base === null) {
				continue;
			}
			const target = RESOLUTION_SUFFIXES.map(
				(suffix) => `${base}${suffix}`
			).find(
				(candidate) => existsSync(candidate) && statSync(candidate).isFile()
			);
			if (target === undefined) {
				unresolved.push(`${file} -> ${specifier}`);
				continue;
			}
			queue.push(target);
		}
	}
	return { offenders, unresolved };
};

test("keeps the Session Engine graph free of React and terminal renderers", () => {
	const { offenders, unresolved } = walkEngineGraph(ENGINE_ENTRY);

	expect(unresolved).toEqual([]);
	expect(offenders).toEqual([]);
});
