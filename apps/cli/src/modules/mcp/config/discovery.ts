import path from "node:path";
import {
	type Node,
	type ParseError,
	parse as parseJsonc,
	parseTree,
} from "jsonc-parser";

export type Scope = "global" | "project";
export type Diagnostic = {
	serverName?: string;
	scope: Scope;
	code:
		| "duplicate-config"
		| "parse-error"
		| "read-error"
		| "invalid-scope"
		| "invalid-server"
		| "invalid-timeout"
		| "invalid-field"
		| "missing-env"
		| "unsupported-auth"
		| "invalid-url"
		| "unsafe-key";
	message: string;
	path: string;
};
export type ScopeData = {
	value: Record<string, unknown>;
	path: string;
	scope: Scope;
};
const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
const findUnsafe = (node: Node | undefined): string | undefined => {
	if (!node) {
		return;
	}
	if (
		node.type === "property" &&
		node.children?.[0]?.value &&
		unsafe.has(String(node.children[0].value))
	) {
		return String(node.children[0].value);
	}
	for (const child of node.children ?? []) {
		const found = findUnsafe(child);
		if (found) {
			return found;
		}
	}
};
const ownObject = (value: Record<string, unknown>): Record<string, unknown> => {
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(value)) {
		result[key] = isObject(value[key])
			? ownObject(value[key] as Record<string, unknown>)
			: value[key];
	}
	return result;
};
const notFound = (e: unknown): boolean => isObject(e) && e.code === "ENOENT";
export async function readScope(
	root: string,
	scope: Scope,
	fs: { readFile(path: string): Promise<string> },
	diagnostics: Diagnostic[]
): Promise<ScopeData> {
	const json = path.join(root, "opencode.json");
	const jsonc = path.join(root, "opencode.jsonc");
	let selected = json;
	let source: string;
	try {
		source = await fs.readFile(jsonc);
		selected = jsonc;
	} catch (e) {
		if (!notFound(e)) {
			diagnostics.push({
				scope,
				code: "read-error",
				message: "Could not read config file",
				path: jsonc,
			});
		}
		try {
			source = await fs.readFile(json);
		} catch (error) {
			if (!notFound(error)) {
				diagnostics.push({
					scope,
					code: "read-error",
					message: "Could not read config file",
					path: json,
				});
			}
			return { value: {}, path: json, scope };
		}
	}
	try {
		await fs.readFile(selected === jsonc ? json : jsonc);
		diagnostics.push({
			scope,
			code: "duplicate-config",
			message: `Ignored duplicate config ${selected === jsonc ? json : jsonc}`,
			path: selected,
		});
	} catch (e) {
		if (!notFound(e)) {
			diagnostics.push({
				scope,
				code: "read-error",
				message: "Could not inspect duplicate config",
				path: selected === jsonc ? json : jsonc,
			});
		}
	}
	const errors: ParseError[] = [];
	const tree = parseTree(source, errors, { allowTrailingComma: true });
	if (
		errors.length ||
		!isObject(
			tree ? parseJsonc(source, [], { allowTrailingComma: true }) : undefined
		)
	) {
		diagnostics.push({
			scope,
			code: "parse-error",
			message: `Could not parse ${selected}`,
			path: selected,
		});
		return { value: {}, path: selected, scope };
	}
	const unsafeKey = findUnsafe(tree);
	if (unsafeKey) {
		diagnostics.push({
			scope,
			code: "unsafe-key",
			message: `Unsafe config key ${unsafeKey}`,
			path: selected,
		});
		return { value: {}, path: selected, scope };
	}
	return {
		value: ownObject(
			parseJsonc(source, [], { allowTrailingComma: true }) as Record<
				string,
				unknown
			>
		),
		path: selected,
		scope,
	};
}
