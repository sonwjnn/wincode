import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getErrorMessage,
	isArray,
	isNull,
	isObjectLike,
	isPlainObject,
	isUndefined,
	logger,
	readUtf8File,
} from "@wincode/utils";
import {
	applyEdits,
	modify,
	type Node,
	type ParseError,
	parse as parseJsonc,
	parseTree,
} from "jsonc-parser";
import { canonicalPath, getProjectRoots } from "@/shared/paths/project-roots";
import { resolveUserWincodeDir } from "@/shared/paths/user-data-dir";

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
	/** Last published settings snapshot, without starting I/O. */
	readSnapshot(workspace: string): ConfigSnapshot | undefined;
	/** Observes settings publication and starts the initial load if needed. */
	subscribeSnapshot(workspace: string, listener: () => void): () => void;
	getSnapshot(workspace: string): Promise<ConfigSnapshot>;
	refreshSnapshot(workspace: string): Promise<ConfigSnapshot>;
	getNamespaceSnapshot(
		workspace: string,
		namespace: string
	): Promise<ConfigSnapshot>;
	refreshNamespaceSnapshot(
		workspace: string,
		namespace: string
	): Promise<ConfigSnapshot>;
	setValue(
		workspace: string,
		scope: ConfigScope,
		path: readonly string[],
		value: unknown,
		targetPath?: string
	): Promise<ConfigSnapshot>;
	setNamespaceValue(
		workspace: string,
		scope: ConfigScope,
		namespace: string,
		path: readonly string[],
		value: unknown,
		targetPath?: string
	): Promise<ConfigSnapshot>;
};
export type ConfigRuntime = {
	configStore: ConfigStore;
	homeRoot: string;
	/** Process launch directory used for per-turn environment context. */
	readonly cwd?: string;
	/** Project roots whose configuration and resources were trusted before loading. */
	readonly trustedProjectRoots?: readonly string[];
	/** Protected project roots skipped because the project is untrusted in this run. */
	readonly untrustedProjectRoots?: readonly string[];
	workspace: string;
};

type ConfigFileSystem = {
	readFile(path: string): Promise<string>;
	writeFile?: (path: string, contents: string) => Promise<void>;
};

export type ConfigStoreOptions = {
	fs?: ConfigFileSystem;
	homeRoot?: string;
	trustedProjectRoots?: readonly string[];
};

type ProvenanceEntry = {
	readonly origin: ConfigOrigin;
	readonly path: readonly string[];
};

type MutableConfigDocument = Record<string, unknown>;

const isNotFound = (error: unknown): boolean =>
	isObjectLike(error) && !isArray(error) && error.code === "ENOENT";

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const namespacePattern = /^[a-z][a-z0-9_-]{0,63}$/u;

const findUnsafeKey = (node: Node | undefined): string | undefined => {
	if (isUndefined(node)) {
		return;
	}
	const propertyName =
		node.type === "property" ? node.children?.[0]?.value : null;
	if (!isNull(propertyName) && unsafeKeys.has(String(propertyName))) {
		return String(propertyName);
	}
	for (const child of node.children ?? []) {
		const unsafeKey = findUnsafeKey(child);
		if (!isUndefined(unsafeKey)) {
			return unsafeKey;
		}
	}
};

const cloneValue = (value: unknown): unknown => {
	if (isArray(value)) {
		return value.map(cloneValue);
	}
	if (!isPlainObject(value)) {
		return value;
	}
	const clone: MutableConfigDocument = Object.create(null);
	for (const [key, child] of Object.entries(value)) {
		clone[key] = cloneValue(child);
	}
	return clone;
};

const freezeValue = <Value>(value: Value): Value => {
	if (isArray(value)) {
		for (const child of value) {
			freezeValue(child);
		}
		return Object.freeze(value);
	}
	if (isPlainObject(value)) {
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
	if (isArray(value)) {
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
	if (isPlainObject(value)) {
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
		if (isPlainObject(current) && isPlainObject(incoming)) {
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
	baseName: string,
	scope: ConfigScope,
	fs: ConfigFileSystem,
	allowJsonc = true
): Promise<SelectedConfigFile> => {
	const jsonPath = path.join(root, `${baseName}.json`);
	if (!allowJsonc) {
		return selectJsonFile(jsonPath, scope, fs);
	}
	const jsoncPath = path.join(root, `${baseName}.jsonc`);
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
	if (isUndefined(selected.contents)) {
		return { document: Object.create(null) };
	}
	const errors: ParseError[] = [];
	const tree = parseTree(selected.contents, errors, {
		allowTrailingComma: true,
	});
	const parsed = isUndefined(tree)
		? undefined
		: parseJsonc(selected.contents, [], { allowTrailingComma: true });
	if (errors.length > 0 || !isObjectLike(parsed) || isArray(parsed)) {
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
	if (!isUndefined(unsafeKey)) {
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
	if (!isPlainObject(parsed)) {
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
	return { document: cloneValue(parsed) as ConfigDocument };
};

const readSource = async (
	root: string,
	baseName: string,
	scope: ConfigScope,
	fs: ConfigFileSystem,
	allowJsonc = true
): Promise<{
	diagnostics: ConfigDiagnostic[];
	source: ConfigSource;
}> => {
	const selected = await selectConfigFile(
		root,
		baseName,
		scope,
		fs,
		allowJsonc
	);
	const parsed = parseDocument(selected, scope);
	return {
		diagnostics: isUndefined(parsed.diagnostic)
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
	options: Required<Pick<ConfigStoreOptions, "fs" | "homeRoot">> &
		Pick<ConfigStoreOptions, "trustedProjectRoots">,
	baseName: string,
	allowJsonc: boolean
): Promise<ConfigSnapshot> => {
	const trustedRoots = options.trustedProjectRoots?.map((root) =>
		path.resolve(root)
	);
	const projectRoots = await Promise.all(
		getProjectRoots(workspace).map(async (root) => ({
			canonical: await canonicalPath(root),
			root,
		}))
	);
	const projectLocations = projectRoots.flatMap(({ canonical, root }) => {
		if (
			trustedRoots === undefined ||
			!(
				trustedRoots.includes(path.resolve(root)) ||
				trustedRoots.includes(canonical)
			)
		) {
			return [];
		}
		return [{ root: path.join(root, ".wincode"), scope: "project" as const }];
	});
	const locations = [
		{ root: resolveUserWincodeDir(options.homeRoot), scope: "global" as const },
		...projectLocations,
	];
	const loaded = await Promise.all(
		locations.map(({ root, scope }) =>
			readSource(root, baseName, scope, options.fs, allowJsonc)
		)
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
				if (!isUndefined(entry)) {
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
		if (!(isPlainObject(current) && Object.hasOwn(current, segment))) {
			return;
		}
		current = current[segment];
	}
	return current;
};

const resolveConfigWritePath = (
	snapshot: ConfigSnapshot,
	scope: ConfigScope,
	configPath: readonly string[],
	targetPath?: string
): string => {
	if (!isUndefined(targetPath)) {
		return (
			snapshot.sources.find(
				(source) => source.scope === scope && source.path === targetPath
			)?.path ?? ""
		);
	}
	const existingSource = snapshot.sources.findLast(
		(source) =>
			source.scope === scope &&
			!isUndefined(valueAtPath(source.document, configPath))
	);
	if (!isUndefined(existingSource)) {
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
		isUndefined(tree) ||
		!isUndefined(findUnsafeKey(tree)) ||
		!isPlainObject(parsed)
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
			return (await fs.stat(file)).mode % 0o1000;
		} catch (error) {
			if (isNotFound(error)) {
				return 0o600;
			}
			throw error;
		}
	})();
	await fs.mkdir(path.dirname(file), { recursive: true });
	try {
		await fs.writeFile(temporaryFile, contents, {
			encoding: "utf8",
			mode,
		});
		await fs.rename(temporaryFile, file);
	} finally {
		await fs.rm(temporaryFile, { force: true });
	}
};

export const createConfigStore = (
	options: ConfigStoreOptions = {}
): ConfigStore => {
	const homeRoot = options.homeRoot ?? os.homedir();
	const fs: ConfigFileSystem =
		options.fs ??
		({
			readFile: (file: string) => readUtf8File(file),
			writeFile: writeConfigFileAtomically,
		} satisfies ConfigFileSystem);
	const loadOptions = {
		fs,
		homeRoot,
		trustedProjectRoots: options.trustedProjectRoots,
	};
	const snapshots = new Map<string, Promise<ConfigSnapshot>>();
	const namespaceSnapshots = new Map<string, Promise<ConfigSnapshot>>();
	const writeQueues = new Map<string, Promise<void>>();
	const publishedSnapshots = new Map<string, ConfigSnapshot>();
	const snapshotListeners = new Map<string, Set<() => void>>();
	const loadSettings = (key: string): Promise<ConfigSnapshot> => {
		const pending = loadSnapshot(key, loadOptions, "settings", true).then(
			(snapshot) => {
				// A slower superseded load must not replace the newest settings.
				if (snapshots.get(key) === pending) {
					publishedSnapshots.set(key, snapshot);
					for (const listener of snapshotListeners.get(key) ?? []) {
						listener();
					}
				}
				return snapshot;
			}
		);
		snapshots.set(key, pending);
		return pending;
	};
	const getSnapshot = (workspace: string): Promise<ConfigSnapshot> => {
		const key = path.resolve(workspace);
		const existing = snapshots.get(key);
		if (!isUndefined(existing)) {
			return existing;
		}
		return loadSettings(key);
	};
	const refreshSnapshot = (workspace: string): Promise<ConfigSnapshot> =>
		loadSettings(path.resolve(workspace));
	const assertNamespace = (namespace: string): void => {
		if (!namespacePattern.test(namespace)) {
			throw new Error("Config namespace must be a lowercase identifier.");
		}
	};
	const namespaceKey = (workspace: string, namespace: string): string =>
		JSON.stringify([path.resolve(workspace), namespace]);
	const getNamespaceSnapshot = (
		workspace: string,
		namespace: string
	): Promise<ConfigSnapshot> => {
		assertNamespace(namespace);
		const key = namespaceKey(workspace, namespace);
		const existing = namespaceSnapshots.get(key);
		if (!isUndefined(existing)) {
			return existing;
		}
		const loaded = loadSnapshot(
			path.resolve(workspace),
			loadOptions,
			namespace,
			false
		);
		namespaceSnapshots.set(key, loaded);
		return loaded;
	};
	const refreshNamespaceSnapshot = (
		workspace: string,
		namespace: string
	): Promise<ConfigSnapshot> => {
		assertNamespace(namespace);
		const key = namespaceKey(workspace, namespace);
		const snapshot = loadSnapshot(
			path.resolve(workspace),
			loadOptions,
			namespace,
			false
		);
		namespaceSnapshots.set(key, snapshot);
		return snapshot;
	};
	const persistValue = async (
		load: (workspace: string) => Promise<ConfigSnapshot>,
		refresh: (workspace: string) => Promise<ConfigSnapshot>,
		workspace: string,
		scope: ConfigScope,
		configPath: readonly string[],
		value: unknown,
		targetPath?: string
	): Promise<ConfigSnapshot> => {
		if (!configPathIsSafe(configPath)) {
			throw new Error("Config path contains an unsafe segment.");
		}
		const snapshot = await load(workspace);
		const target = resolveConfigWritePath(
			snapshot,
			scope,
			configPath,
			targetPath
		);
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
					isUndefined(value) &&
					(!isPlainObject(document) ||
						isUndefined(valueAtPath(document, configPath)))
				) {
					return;
				}
				const updated = applyEdits(
					contents,
					modify(contents, [...configPath], value, {
						formattingOptions: { insertSpaces: true, tabSize: 2 },
					})
				);
				if (isUndefined(fs.writeFile)) {
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
		return refresh(workspace);
	};
	return {
		readSnapshot: (workspace) =>
			publishedSnapshots.get(path.resolve(workspace)),
		subscribeSnapshot: (workspace, listener) => {
			const key = path.resolve(workspace);
			let listeners = snapshotListeners.get(key);
			if (listeners === undefined) {
				listeners = new Set();
				snapshotListeners.set(key, listeners);
			}
			listeners.add(listener);
			void getSnapshot(key).catch((error: unknown) => {
				logger.warn("Config snapshot load failed", {
					error: getErrorMessage(error),
					workspace: key,
				});
			});
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					snapshotListeners.delete(key);
				}
			};
		},
		getSnapshot,
		refreshSnapshot,
		getNamespaceSnapshot,
		refreshNamespaceSnapshot,
		setValue: (workspace, scope, configPath, value, targetPath) =>
			persistValue(
				getSnapshot,
				refreshSnapshot,
				workspace,
				scope,
				configPath,
				value,
				targetPath
			),
		setNamespaceValue: (
			workspace,
			scope,
			namespace,
			configPath,
			value,
			targetPath
		) => {
			assertNamespace(namespace);
			return persistValue(
				(workspacePath) => getNamespaceSnapshot(workspacePath, namespace),
				(workspacePath) => refreshNamespaceSnapshot(workspacePath, namespace),
				workspace,
				scope,
				configPath,
				value,
				targetPath
			);
		},
	};
};
