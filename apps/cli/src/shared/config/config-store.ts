import {
	mkdir,
	rename,
	rm,
	stat,
	writeFile as writeFileToDisk,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	modify,
	type Node,
	type ParseError,
	parse as parseJsonc,
	parseTree,
} from "jsonc-parser";
import { getProjectRoots } from "@/shared/paths/project-roots";

export type ConfigScope = "global" | "project";
export type ConfigOrigin = {
	readonly path: string;
	readonly scope: ConfigScope;
};
export type ConfigDocument = Readonly<Record<string, unknown>>;
export type ConfigSource = ConfigOrigin & {
	readonly document: ConfigDocument;
};
export type ConfigDiagnostic = ConfigOrigin & {
	readonly code:
		| "duplicate-config"
		| "parse-error"
		| "read-error"
		| "unsafe-key";
	readonly message: string;
};
export type ConfigSnapshot = {
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly document: ConfigDocument;
	sourceFor(path: readonly string[]): ConfigOrigin | undefined;
	readonly sources: readonly ConfigSource[];
};
export type ConfigStore = {
	getSnapshot(workspace: string): Promise<ConfigSnapshot>;
	refreshSnapshot(workspace: string): Promise<ConfigSnapshot>;
	setValue(
		workspace: string,
		scope: ConfigScope,
		path: readonly string[],
		value: unknown
	): Promise<ConfigSnapshot>;
};
export type ConfigRuntime = {
	configStore: ConfigStore;
	homeRoot: string;
	workspace: string;
};

type ConfigFileSystem = {
	readFile(path: string): Promise<string>;
	writeFile?: (path: string, contents: string) => Promise<void>;
};

export type ConfigStoreOptions = {
	configRoot?: string;
	fs?: ConfigFileSystem;
	homeRoot?: string;
	xdgConfigHome?: string;
};

type ProvenanceEntry = {
	readonly origin: ConfigOrigin;
	readonly path: readonly string[];
};

type MutableConfigDocument = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNotFound = (error: unknown): boolean =>
	isObject(error) && error.code === "ENOENT";

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

const findUnsafeKey = (node: Node | undefined): string | undefined => {
	if (node === undefined) {
		return;
	}
	const propertyName =
		node.type === "property" ? node.children?.[0]?.value : null;
	if (propertyName !== null && unsafeKeys.has(String(propertyName))) {
		return String(propertyName);
	}
	for (const child of node.children ?? []) {
		const unsafeKey = findUnsafeKey(child);
		if (unsafeKey !== undefined) {
			return unsafeKey;
		}
	}
};

const cloneValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(cloneValue);
	}
	if (!isObject(value)) {
		return value;
	}
	const clone: MutableConfigDocument = Object.create(null);
	for (const [key, child] of Object.entries(value)) {
		clone[key] = cloneValue(child);
	}
	return clone;
};

const freezeValue = <Value>(value: Value): Value => {
	if (Array.isArray(value)) {
		for (const child of value) {
			freezeValue(child);
		}
		return Object.freeze(value);
	}
	if (isObject(value)) {
		for (const child of Object.values(value)) {
			freezeValue(child);
		}
		return Object.freeze(value);
	}
	return value;
};

const pathKey = (segments: readonly string[]): string =>
	JSON.stringify(segments);

const startsWithPath = (
	pathSegments: readonly string[],
	prefix: readonly string[]
): boolean =>
	prefix.length <= pathSegments.length &&
	prefix.every((segment, index) => pathSegments[index] === segment);

const removeProvenance = (
	provenance: Map<string, ProvenanceEntry>,
	pathSegments: readonly string[]
): void => {
	for (const [key, entry] of provenance) {
		if (startsWithPath(entry.path, pathSegments)) {
			provenance.delete(key);
		}
	}
};

const recordProvenance = (
	provenance: Map<string, ProvenanceEntry>,
	pathSegments: readonly string[],
	value: unknown,
	origin: ConfigOrigin
): void => {
	provenance.set(pathKey(pathSegments), { origin, path: pathSegments });
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			recordProvenance(
				provenance,
				[...pathSegments, String(index)],
				child,
				origin
			);
		}
		return;
	}
	if (isObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			recordProvenance(provenance, [...pathSegments, key], child, origin);
		}
	}
};

const mergeDocument = (
	target: MutableConfigDocument,
	patch: ConfigDocument,
	origin: ConfigOrigin,
	provenance: Map<string, ProvenanceEntry>,
	parentPath: readonly string[] = []
): void => {
	for (const [key, incoming] of Object.entries(patch)) {
		const valuePath = [...parentPath, key];
		const current = target[key];
		if (isObject(current) && isObject(incoming)) {
			provenance.set(pathKey(valuePath), { origin, path: valuePath });
			mergeDocument(current, incoming, origin, provenance, valuePath);
			continue;
		}
		removeProvenance(provenance, valuePath);
		target[key] = cloneValue(incoming);
		recordProvenance(provenance, valuePath, incoming, origin);
	}
};

type FileReadResult =
	| { kind: "found"; contents: string }
	| { kind: "missing" }
	| { kind: "error" };

const readFile = async (
	fs: ConfigFileSystem,
	file: string
): Promise<FileReadResult> => {
	try {
		return { contents: await fs.readFile(file), kind: "found" };
	} catch (error) {
		if (isNotFound(error)) {
			return { kind: "missing" };
		}
		return { kind: "error" };
	}
};

type SelectedConfigFile = {
	contents?: string;
	diagnostics: ConfigDiagnostic[];
	path: string;
};

const diagnostic = (
	code: ConfigDiagnostic["code"],
	message: string,
	path: string,
	scope: ConfigScope
): ConfigDiagnostic => ({ code, message, path, scope });

const selectJsonFile = async (
	jsonPath: string,
	scope: ConfigScope,
	fs: ConfigFileSystem
): Promise<SelectedConfigFile> => {
	const json = await readFile(fs, jsonPath);
	if (json.kind === "found") {
		return { contents: json.contents, diagnostics: [], path: jsonPath };
	}
	return {
		diagnostics:
			json.kind === "error"
				? [
						diagnostic(
							"read-error",
							"Could not read config file",
							jsonPath,
							scope
						),
					]
				: [],
		path: jsonPath,
	};
};

const selectJsoncFile = async (
	jsoncContents: string,
	jsonPath: string,
	jsoncPath: string,
	scope: ConfigScope,
	fs: ConfigFileSystem
): Promise<SelectedConfigFile> => {
	const duplicate = await readFile(fs, jsonPath);
	const diagnostics: ConfigDiagnostic[] = [];
	if (duplicate.kind === "found") {
		diagnostics.push(
			diagnostic(
				"duplicate-config",
				`Ignored duplicate config ${jsonPath}`,
				jsoncPath,
				scope
			)
		);
	} else if (duplicate.kind === "error") {
		diagnostics.push(
			diagnostic(
				"read-error",
				"Could not inspect duplicate config",
				jsonPath,
				scope
			)
		);
	}
	return { contents: jsoncContents, diagnostics, path: jsoncPath };
};

const selectConfigFile = async (
	root: string,
	scope: ConfigScope,
	fs: ConfigFileSystem
): Promise<SelectedConfigFile> => {
	const jsonPath = path.join(root, "wincode.json");
	const jsoncPath = path.join(root, "wincode.jsonc");
	const jsonc = await readFile(fs, jsoncPath);
	if (jsonc.kind === "found") {
		return selectJsoncFile(jsonc.contents, jsonPath, jsoncPath, scope, fs);
	}
	if (jsonc.kind === "error") {
		return {
			diagnostics: [
				diagnostic(
					"read-error",
					"Could not read config file",
					jsoncPath,
					scope
				),
			],
			path: jsoncPath,
		};
	}
	return selectJsonFile(jsonPath, scope, fs);
};

const parseDocument = (
	selected: SelectedConfigFile,
	scope: ConfigScope
): { diagnostic?: ConfigDiagnostic; document: ConfigDocument } => {
	if (selected.contents === undefined) {
		return { document: Object.create(null) };
	}
	const errors: ParseError[] = [];
	const tree = parseTree(selected.contents, errors, {
		allowTrailingComma: true,
	});
	const parsed =
		tree === undefined
			? undefined
			: parseJsonc(selected.contents, [], { allowTrailingComma: true });
	if (errors.length > 0 || !isObject(parsed)) {
		return {
			diagnostic: diagnostic(
				"parse-error",
				`Could not parse ${selected.path}`,
				selected.path,
				scope
			),
			document: Object.create(null),
		};
	}
	const unsafeKey = findUnsafeKey(tree);
	if (unsafeKey !== undefined) {
		return {
			diagnostic: diagnostic(
				"unsafe-key",
				`Unsafe config key ${unsafeKey}`,
				selected.path,
				scope
			),
			document: Object.create(null),
		};
	}
	return { document: cloneValue(parsed) as ConfigDocument };
};

const readSource = async (
	root: string,
	scope: ConfigScope,
	fs: ConfigFileSystem
): Promise<{
	diagnostics: ConfigDiagnostic[];
	source: ConfigSource;
}> => {
	const selected = await selectConfigFile(root, scope, fs);
	const parsed = parseDocument(selected, scope);
	return {
		diagnostics:
			parsed.diagnostic === undefined
				? selected.diagnostics
				: [...selected.diagnostics, parsed.diagnostic],
		source: {
			document: parsed.document,
			path: selected.path,
			scope,
		},
	};
};

const loadSnapshot = async (
	workspace: string,
	options: Required<Pick<ConfigStoreOptions, "configRoot" | "fs" | "homeRoot">>
): Promise<ConfigSnapshot> => {
	const projectLocations = getProjectRoots(workspace).flatMap((root) => [
		{ root, scope: "project" as const },
		{ root: path.join(root, ".wincode"), scope: "project" as const },
	]);
	const locations = [
		{ root: options.configRoot, scope: "global" as const },
		{ root: path.join(options.homeRoot, ".wincode"), scope: "global" as const },
		...projectLocations,
	];
	const loaded = await Promise.all(
		locations.map(({ root, scope }) => readSource(root, scope, options.fs))
	);
	const sources = loaded.map(({ source }) => source);
	const document: MutableConfigDocument = Object.create(null);
	const provenance = new Map<string, ProvenanceEntry>();
	for (const { document: sourceDocument, path: sourcePath, scope } of sources) {
		const origin = Object.freeze({ path: sourcePath, scope });
		mergeDocument(document, sourceDocument, origin, provenance);
	}
	const frozenSources = Object.freeze(
		sources.map((source) =>
			Object.freeze({ ...source, document: freezeValue(source.document) })
		)
	);
	const frozenDiagnostics = Object.freeze(
		loaded
			.flatMap(({ diagnostics }) => diagnostics)
			.map((entry) => Object.freeze(entry))
	);
	return Object.freeze({
		diagnostics: frozenDiagnostics,
		document: freezeValue(document),
		sourceFor: (pathSegments: readonly string[]) => {
			for (let length = pathSegments.length; length > 0; length -= 1) {
				const entry = provenance.get(pathKey(pathSegments.slice(0, length)));
				if (entry !== undefined) {
					return entry.origin;
				}
			}
		},
		sources: frozenSources,
	});
};

const configPathIsSafe = (configPath: readonly string[]): boolean =>
	configPath.length > 0 &&
	configPath.every((segment) => segment.length > 0 && !unsafeKeys.has(segment));

const valueAtPath = (
	document: ConfigDocument,
	configPath: readonly string[]
): unknown => {
	let current: unknown = document;
	for (const segment of configPath) {
		if (!(isObject(current) && Object.hasOwn(current, segment))) {
			return;
		}
		current = current[segment];
	}
	return current;
};

const resolveConfigWritePath = (
	snapshot: ConfigSnapshot,
	scope: ConfigScope,
	configPath: readonly string[]
): string => {
	const existingSource = snapshot.sources.findLast(
		(source) =>
			source.scope === scope &&
			valueAtPath(source.document, configPath) !== undefined
	);
	if (existingSource !== undefined) {
		return existingSource.path;
	}

	const scopedSources = snapshot.sources.filter(
		(source) => source.scope === scope
	);
	return (
		(scope === "global" ? scopedSources[0] : scopedSources.at(-1))?.path ?? ""
	);
};

const readConfigForWrite = async (
	fs: ConfigFileSystem,
	file: string
): Promise<string> => {
	const result = await readFile(fs, file);
	if (result.kind === "missing") {
		return "{}\n";
	}
	if (result.kind === "error") {
		throw new Error(`Could not read config file ${file}.`);
	}

	const errors: ParseError[] = [];
	const tree = parseTree(result.contents, errors, {
		allowTrailingComma: true,
	});
	const parsed = parseJsonc(result.contents, errors, {
		allowTrailingComma: true,
	});
	if (
		errors.length > 0 ||
		tree === undefined ||
		findUnsafeKey(tree) !== undefined ||
		!isObject(parsed)
	) {
		throw new Error(`Could not update invalid config file ${file}.`);
	}
	return result.contents;
};

const writeConfigFileAtomically = async (
	file: string,
	contents: string
): Promise<void> => {
	const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const mode = await (async () => {
		try {
			return (await stat(file)).mode % 0o1000;
		} catch (error) {
			if (isNotFound(error)) {
				return 0o600;
			}
			throw error;
		}
	})();
	await mkdir(path.dirname(file), { recursive: true });
	try {
		await writeFileToDisk(temporaryFile, contents, {
			encoding: "utf8",
			mode,
		});
		await rename(temporaryFile, file);
	} finally {
		await rm(temporaryFile, { force: true });
	}
};

export const createConfigStore = (
	options: ConfigStoreOptions = {}
): ConfigStore => {
	const homeRoot = options.homeRoot ?? homedir();
	const xdgConfigHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
	const configRoot =
		options.configRoot ??
		path.join(
			typeof xdgConfigHome === "string" && xdgConfigHome.length > 0
				? xdgConfigHome
				: path.join(homeRoot, ".config"),
			"wincode"
		);
	const fs: ConfigFileSystem =
		options.fs ??
		({
			readFile: (file: string) => globalThis.Bun.file(file).text(),
			writeFile: writeConfigFileAtomically,
		} satisfies ConfigFileSystem);
	const snapshots = new Map<string, Promise<ConfigSnapshot>>();
	const writeQueues = new Map<string, Promise<void>>();
	const getSnapshot = (workspace: string): Promise<ConfigSnapshot> => {
		const key = path.resolve(workspace);
		const existing = snapshots.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const loaded = loadSnapshot(key, { configRoot, fs, homeRoot });
		snapshots.set(key, loaded);
		return loaded;
	};
	const refreshSnapshot = (workspace: string): Promise<ConfigSnapshot> => {
		const key = path.resolve(workspace);
		const snapshot = loadSnapshot(key, { configRoot, fs, homeRoot });
		snapshots.set(key, snapshot);
		return snapshot;
	};
	return {
		getSnapshot,
		refreshSnapshot,
		setValue: async (workspace, scope, configPath, value) => {
			if (!configPathIsSafe(configPath)) {
				throw new Error("Config path contains an unsafe segment.");
			}
			const snapshot = await getSnapshot(workspace);
			const target = resolveConfigWritePath(snapshot, scope, configPath);
			if (target.length === 0) {
				throw new Error(`Could not resolve ${scope} config file.`);
			}
			const previous = writeQueues.get(target) ?? Promise.resolve();
			const current = previous
				.catch(() => undefined)
				.then(async () => {
					const contents = await readConfigForWrite(fs, target);
					const document = parseJsonc(contents, [], {
						allowTrailingComma: true,
					});
					if (
						value === undefined &&
						(!isObject(document) ||
							valueAtPath(document, configPath) === undefined)
					) {
						return;
					}
					const updated = applyEdits(
						contents,
						modify(contents, [...configPath], value, {
							formattingOptions: { insertSpaces: true, tabSize: 2 },
						})
					);
					if (fs.writeFile === undefined) {
						throw new Error("Config persistence is unavailable.");
					}
					await fs.writeFile(target, updated);
				});
			writeQueues.set(target, current);
			try {
				await current;
			} finally {
				if (writeQueues.get(target) === current) {
					writeQueues.delete(target);
				}
			}
			return refreshSnapshot(workspace);
		},
	};
};
