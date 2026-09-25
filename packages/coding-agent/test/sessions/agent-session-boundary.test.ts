import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * ADR-0019's non-TUI reuse boundary and ADR-0023's Host boundary require both
 * the Agent Session and Session Host graphs to stay free of React and terminal
 * renderers. Lint catches direct imports; this walks transitively so a barrel
 * cannot smuggle a renderer into either entry point.
 */
const TUI_ROOT = resolve(import.meta.dir, "../..");
const FORBIDDEN_MODULE_ROOTS: Record<string, true> = {
	"@opentui": true,
	react: true,
	"react-dom": true,
};
const MODULE_EDGE_PATTERN =
	/(?:^|\n)(?!\s*(?:import|export)\s+type\b)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/gu;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * The entries a non-renderer consumer loads: the Agent Session and the Host
 * that assembles it.
 */
const ENTRIES = [
	{
		name: "Agent Session",
		path: resolve(TUI_ROOT, "modules/sessions/engine/agent-session.ts"),
	},
	{
		name: "Session Host",
		path: resolve(TUI_ROOT, "modules/sessions/host/session-host.ts"),
	},
	{
		name: "Session Capabilities",
		path: resolve(TUI_ROOT, "modules/sessions/host/session-capabilities.ts"),
	},
	{
		name: "Session RPC boundary",
		path: resolve(TUI_ROOT, "modules/sessions/host/session-rpc.ts"),
	},
];

const walkModuleGraph = (
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
			if (Object.hasOwn(FORBIDDEN_MODULE_ROOTS, moduleRoot)) {
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

for (const { name, path } of ENTRIES) {
	test(`keeps the ${name} graph free of React and terminal renderers`, () => {
		const { offenders, unresolved } = walkModuleGraph(path);

		expect(unresolved).toEqual([]);
		expect(offenders).toEqual([]);
	});
}
