import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";

export type SessionStorageBoundarySymbol =
	| "SessionStorage"
	| "SessionProjection"
	| "SessionAttachmentStore";

type SessionStorageFacetSymbol =
	| "SessionRecords"
	| "SessionCatalog"
	| "SessionHistory"
	| "SessionLifecycle"
	| "SessionAttachments"
	| "PluginSessionState";

export type SessionStorageBoundaryFinding = Readonly<{
	expectation: string;
	file: string;
	line: number;
	restrictedSymbol: SessionStorageBoundarySymbol;
}>;

export type SessionStorageBoundaryReport = Readonly<{
	findings: readonly SessionStorageBoundaryFinding[];
	scannedFiles: number;
}>;

type AstNode = Readonly<Record<string, unknown>> & Readonly<{ type: string }>;

type ResolvedModuleSymbol =
	| Readonly<{ kind: "namespace"; modulePath: string }>
	| Readonly<{ kind: "facet"; symbol: SessionStorageFacetSymbol }>
	| Readonly<{
			kind: "restricted";
			symbol: SessionStorageBoundarySymbol;
	  }>;

type ParsedSource = Readonly<{
	program: AstNode;
	sourceText: string;
}>;

type ImportBindings = Readonly<{
	named: ReadonlyMap<string, ResolvedModuleSymbol>;
	namespaces: ReadonlyMap<string, string>;
}>;

const SOURCE_EXTENSION_PATTERN = /\.tsx?$/u;
const RESOLUTION_SUFFIXES = [
	"",
	".ts",
	".tsx",
	".d.ts",
	"/index.ts",
	"/index.tsx",
];
const IGNORED_DIRECTORY_NAMES: Record<string, true> = {
	".git": true,
	".next": true,
	".turbo": true,
	build: true,
	coverage: true,
	dist: true,
	generated: true,
	node_modules: true,
	out: true,
	"test-artifacts": true,
};
const SESSION_FACET_SOURCE_PATHS: Readonly<
	Record<string, SessionStorageFacetSymbol>
> = {
	"modules/sessions/storage/plugin-session-state.ts": "PluginSessionState",
	"modules/sessions/storage/session-attachments.ts": "SessionAttachments",
	"modules/sessions/storage/session-catalog.ts": "SessionCatalog",
	"modules/sessions/storage/session-history.ts": "SessionHistory",
	"modules/sessions/storage/session-lifecycle.ts": "SessionLifecycle",
	"modules/sessions/storage/session-records.ts": "SessionRecords",
};
const SESSION_STORAGE_FACETS: ReadonlySet<SessionStorageFacetSymbol> = new Set(
	Object.values(SESSION_FACET_SOURCE_PATHS)
);
const RESTRICTED_SOURCE_PATHS: Readonly<
	Record<string, SessionStorageBoundarySymbol>
> = {
	"modules/sessions/storage/attachment-store.ts": "SessionAttachmentStore",
	"modules/sessions/storage/session-projection.ts": "SessionProjection",
	"modules/sessions/storage/session-storage.ts": "SessionStorage",
};
const AGGREGATE_ASSEMBLY_FILES: Record<string, true> = {
	"modules/sessions/host/session-capabilities.ts": true,
	"modules/sessions/host/session-services.ts": true,
	"modules/sessions/host/types.ts": true,
	"modules/sessions/sdk.ts": true,
	"modules/sessions/storage/get-session-storage.ts": true,
	"modules/sessions/storage/session-jsonl-store.ts": true,
	"scripts/session-jsonl-benchmark.ts": true,
};
// These test files explicitly compose a complete store or exercise its runtime assembly.
const AGGREGATE_TEST_FILES: Record<string, true> = {
	"test/application/sessions-cli.test.ts": true,
	"test/rpc.test.ts": true,
	"test/sessions/session-bundle-export.test.ts": true,
	"test/sessions/session-bundle-import.test.ts": true,
	"test/sessions/session-fork.test.ts": true,
	"test/sessions/session-host.test.ts": true,
	"test/sessions/session-jsonl-sdk.test.ts": true,
	"test/sessions/session-opening.e2e.test.tsx": true,
	"test/sessions/session-plugin-state.test.ts": true,
	"test/sessions/session-projection-freshness.test.ts": true,
	"test/sessions/session-sdk.test.ts": true,
	"test/support/e2e-fixture.tsx": true,
	"test/support/session-facets/storage.ts": true,
	"test/support/session-jsonl-storage.ts": true,
};
const SESSION_PROJECTION_TEST_FILES: Record<string, true> = {
	"test/sessions/recovery.test.ts": true,
	"test/sessions/session-record.test.ts": true,
	"test/sessions/session-writer-lock.test.ts": true,
	"test/sessions/versioned-editing.test.ts": true,
};
const RAW_ATTACHMENT_TEST_FILES: Record<string, true> = {
	"test/sessions/attachment-store.test.ts": true,
	"test/sessions/session-bundle-export.test.ts": true,
	"test/sessions/session-bundle-import.test.ts": true,
	"test/sessions/session-jsonl-sdk.test.ts": true,
	"test/support/session-facets/attachments.ts": true,
	"test/support/session-facets/storage.ts": true,
	"test/support/session-jsonl-storage.ts": true,
};
const RESTRICTED_SYMBOLS: readonly SessionStorageBoundarySymbol[] = [
	"SessionStorage",
	"SessionProjection",
	"SessionAttachmentStore",
];

const normalizePath = (value: string): string =>
	value.split(path.sep).join("/");

const isMissingPathError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT";

const walkSourceFiles = (
	root: string,
	currentPath: string,
	files: string[]
): void => {
	const directory = path.join(root, currentPath);
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name));
	} catch (error) {
		if (isMissingPathError(error)) {
			return;
		}
		throw error;
	}
	for (const entry of entries) {
		const entryPath = currentPath
			? path.join(currentPath, entry.name)
			: entry.name;
		if (entry.isDirectory()) {
			if (Object.hasOwn(IGNORED_DIRECTORY_NAMES, entry.name)) {
				continue;
			}
			walkSourceFiles(root, entryPath, files);
			continue;
		}
		if (
			entry.isFile() &&
			SOURCE_EXTENSION_PATTERN.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			files.push(path.resolve(root, entryPath));
		}
	}
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const asAstNode = (value: unknown): AstNode | undefined => {
	const candidate = asRecord(value);
	return candidate !== undefined && typeof candidate.type === "string"
		? (candidate as AstNode)
		: undefined;
};

const nodeField = (node: AstNode, field: string): AstNode | undefined =>
	asAstNode(node[field]);

const nodeArrayField = (node: AstNode, field: string): readonly AstNode[] => {
	const value = node[field];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(asAstNode).filter((child) => child !== undefined);
};

const stringField = (node: AstNode, field: string): string | undefined => {
	const value = node[field];
	return typeof value === "string" ? value : undefined;
};

const identifierName = (node: AstNode | undefined): string | undefined =>
	node?.type === "Identifier" ? stringField(node, "name") : undefined;

const exportName = (node: AstNode | undefined): string | undefined => {
	if (node === undefined) {
		return;
	}
	if (node.type === "Identifier") {
		return stringField(node, "name");
	}
	if (node.type === "StringLiteral") {
		return stringField(node, "value");
	}
	return;
};

const stringLiteralValue = (node: AstNode | undefined): string | undefined =>
	node?.type === "StringLiteral" ? stringField(node, "value") : undefined;

const sourceSpecifier = (node: AstNode): string | undefined =>
	stringLiteralValue(nodeField(node, "source"));

const lineOf = (source: ParsedSource, node: AstNode): number => {
	const location = asRecord(node.loc);
	const start = location === undefined ? undefined : asRecord(location.start);
	const line = start?.line;
	if (typeof line === "number") {
		return line;
	}
	const position = node.start;
	if (typeof position !== "number") {
		return 1;
	}
	return source.sourceText.slice(0, position).split("\n").length;
};

const isStorageImplementationFile = (relativePath: string): boolean =>
	relativePath.startsWith("modules/sessions/storage/");

const restrictedExpectation = (
	symbol: SessionStorageBoundarySymbol
): string => {
	switch (symbol) {
		case "SessionStorage":
			return "Use the specific Session facet(s) this consumer needs; the aggregate belongs only at the named storage and composition boundaries.";
		case "SessionProjection":
			return "Keep the internal SessionProjection interface inside storage or a focused projection test; consumers should use the async Session facets and ProjectedSession read modes.";
		case "SessionAttachmentStore":
			return "Use the consumer-facing SessionAttachments facet instead of the raw attachment sub-store.";
		default:
			throw new Error(
				`Unknown restricted Session storage symbol: ${String(symbol)}`
			);
	}
};

const isAllowedRestrictedImport = (
	relativePath: string,
	symbol: SessionStorageBoundarySymbol
): boolean => {
	if (symbol === "SessionStorage") {
		return (
			Object.hasOwn(AGGREGATE_ASSEMBLY_FILES, relativePath) ||
			Object.hasOwn(AGGREGATE_TEST_FILES, relativePath)
		);
	}
	if (symbol === "SessionProjection") {
		return (
			isStorageImplementationFile(relativePath) ||
			Object.hasOwn(SESSION_PROJECTION_TEST_FILES, relativePath)
		);
	}
	return (
		isStorageImplementationFile(relativePath) ||
		Object.hasOwn(AGGREGATE_ASSEMBLY_FILES, relativePath) ||
		Object.hasOwn(RAW_ATTACHMENT_TEST_FILES, relativePath)
	);
};

const typeAliasAncestor = (
	ancestors: readonly AstNode[]
): AstNode | undefined =>
	ancestors.find((ancestor) => ancestor.type === "TSTypeAliasDeclaration");

const hasPropertyAncestor = (
	ancestors: readonly AstNode[],
	propertyName: string
): boolean =>
	ancestors.some(
		(ancestor) =>
			(ancestor.type === "TSPropertySignature" ||
				ancestor.type === "ClassProperty" ||
				ancestor.type === "ObjectTypeProperty") &&
			exportName(nodeField(ancestor, "key")) === propertyName
	);

const hasFunctionVariableAncestor = (
	ancestors: readonly AstNode[],
	variableName: string
): boolean =>
	ancestors.some((ancestor) => {
		if (ancestor.type !== "VariableDeclarator") {
			return false;
		}
		const functionName = identifierName(nodeField(ancestor, "id"));
		const initializer = nodeField(ancestor, "init");
		return (
			functionName === variableName &&
			(initializer?.type === "ArrowFunctionExpression" ||
				initializer?.type === "FunctionExpression")
		);
	});

const isInsideNamedFunction = (
	ancestors: readonly AstNode[],
	functionName: string
): boolean =>
	ancestors.some((ancestor) => {
		if (ancestor.type === "FunctionDeclaration") {
			return identifierName(nodeField(ancestor, "id")) === functionName;
		}
		if (ancestor.type !== "VariableDeclarator") {
			return false;
		}
		const initializer = nodeField(ancestor, "init");
		return (
			identifierName(nodeField(ancestor, "id")) === functionName &&
			(initializer?.type === "ArrowFunctionExpression" ||
				initializer?.type === "FunctionExpression")
		);
	});

const hasIdentifierAncestor = (
	ancestors: readonly AstNode[],
	name: string
): boolean => ancestors.some((ancestor) => identifierName(ancestor) === name);

const typeAliasName = (ancestors: readonly AstNode[]): string | undefined => {
	const alias = typeAliasAncestor(ancestors);
	return alias === undefined
		? undefined
		: identifierName(nodeField(alias, "id"));
};

const localTypeAliases = (program: AstNode): ReadonlyMap<string, AstNode> => {
	const aliases = new Map<string, AstNode>();
	for (const statement of nodeArrayField(program, "body")) {
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? nodeField(statement, "declaration")
				: statement;
		if (declaration?.type !== "TSTypeAliasDeclaration") {
			continue;
		}
		const name = identifierName(nodeField(declaration, "id"));
		if (name !== undefined) {
			aliases.set(name, declaration);
		}
	}
	return aliases;
};

const isStoragePropertyOnAlias = (
	ancestors: readonly AstNode[],
	aliasNames: readonly string[]
): boolean => {
	const aliasName = typeAliasName(ancestors);
	return (
		aliasName !== undefined &&
		aliasNames.includes(aliasName) &&
		hasPropertyAncestor(ancestors, "storage")
	);
};

const isAllowedCachedStorageUse = (ancestors: readonly AstNode[]): boolean =>
	isStoragePropertyOnAlias(ancestors, ["CachedStorage"]) ||
	hasFunctionVariableAncestor(ancestors, "getSessionStorage");

const isAllowedSessionServicesUse = (ancestors: readonly AstNode[]): boolean =>
	isStoragePropertyOnAlias(ancestors, [
		"SessionServicesSources",
		"SessionServices",
	]);

const isAllowedSessionCapabilitiesUse = (
	ancestors: readonly AstNode[]
): boolean =>
	isStoragePropertyOnAlias(ancestors, [
		"SessionCapabilitiesOptions",
		"SessionCapabilitiesAssembly",
	]) ||
	(hasIdentifierAncestor(ancestors, "storage") &&
		isInsideNamedFunction(ancestors, "createSessionCapabilities"));

const isAllowedHostTypeUse = (ancestors: readonly AstNode[]): boolean =>
	isStoragePropertyOnAlias(ancestors, ["SessionHostOptions"]) ||
	(isStoragePropertyOnAlias(ancestors, ["SessionHostManager"]) &&
		hasPropertyAncestor(ancestors, "openHost"));

const isAllowedSdkRuntimeFactoryUse = (
	ancestors: readonly AstNode[]
): boolean =>
	isStoragePropertyOnAlias(ancestors, ["SharedSessionSdkResources"]) ||
	(hasIdentifierAncestor(ancestors, "storage") &&
		hasFunctionVariableAncestor(ancestors, "createSessionSdkRuntimeFactory"));

const AGGREGATE_TYPE_USE_RULES: Readonly<
	Record<string, (ancestors: readonly AstNode[]) => boolean>
> = {
	"modules/sessions/host/session-capabilities.ts":
		isAllowedSessionCapabilitiesUse,
	"modules/sessions/host/session-services.ts": isAllowedSessionServicesUse,
	"modules/sessions/host/types.ts": isAllowedHostTypeUse,
	"modules/sessions/sdk.ts": isAllowedSdkRuntimeFactoryUse,
	"modules/sessions/storage/get-session-storage.ts": isAllowedCachedStorageUse,
	"modules/sessions/storage/session-jsonl-store.ts": (ancestors) =>
		isInsideNamedFunction(ancestors, "createSessionJsonlStore"),
};

const isAllowedAggregateTypeUse = (
	relativePath: string,
	ancestors: readonly AstNode[]
): boolean => {
	if (relativePath === "modules/sessions/storage/session-storage.ts") {
		return false;
	}
	return AGGREGATE_TYPE_USE_RULES[relativePath]?.(ancestors) ?? false;
};

const resolveSourcePath = (
	packageRoot: string,
	fromFile: string,
	specifier: string,
	sourceFiles: ReadonlyMap<string, ParsedSource>
): string | undefined => {
	let base: string;
	if (specifier.startsWith("@/")) {
		base = path.resolve(packageRoot, specifier.slice(2));
	} else if (specifier.startsWith(".")) {
		base = path.resolve(path.dirname(fromFile), specifier);
	} else {
		return;
	}
	const bases = [base];
	if (base.endsWith(".js")) {
		bases.push(`${base.slice(0, -3)}.ts`);
	}
	if (base.endsWith(".jsx")) {
		bases.push(`${base.slice(0, -4)}.tsx`);
	}
	for (const candidateBase of bases) {
		for (const suffix of RESOLUTION_SUFFIXES) {
			const candidate = path.resolve(`${candidateBase}${suffix}`);
			if (sourceFiles.has(candidate)) {
				return candidate;
			}
		}
	}
	return;
};

class RestrictedExportResolver {
	readonly #packageRoot: string;
	readonly #sourceFiles: ReadonlyMap<string, ParsedSource>;
	readonly #cache = new Map<string, ResolvedModuleSymbol | null>();

	constructor(
		packageRoot: string,
		sourceFiles: ReadonlyMap<string, ParsedSource>
	) {
		this.#packageRoot = packageRoot;
		this.#sourceFiles = sourceFiles;
	}

	resolveModule = (fromFile: string, specifier: string): string | undefined =>
		resolveSourcePath(
			this.#packageRoot,
			fromFile,
			specifier,
			this.#sourceFiles
		);

	resolveExport = (
		modulePath: string,
		exportedName: string,
		visited: ReadonlySet<string> = new Set()
	): ResolvedModuleSymbol | undefined => {
		const cacheKey = `${modulePath}#${exportedName}`;
		const cached = this.#cache.get(cacheKey);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		if (visited.has(cacheKey)) {
			return;
		}
		const restrictedSymbol = this.#restrictedSymbolAt(modulePath, exportedName);
		if (restrictedSymbol !== undefined) {
			return this.#cacheResult(cacheKey, {
				kind: "restricted",
				symbol: restrictedSymbol,
			});
		}
		const facetSymbol = this.#sessionFacetAt(modulePath, exportedName);
		if (facetSymbol !== undefined) {
			return this.#cacheResult(cacheKey, {
				kind: "facet",
				symbol: facetSymbol,
			});
		}
		const parsed = this.#sourceFiles.get(modulePath);
		if (parsed === undefined) {
			return this.#cacheResult(cacheKey, undefined);
		}
		const nextVisited = new Set(visited).add(cacheKey);
		return this.#cacheResult(
			cacheKey,
			this.#resolveExportStatements(
				modulePath,
				exportedName,
				nodeArrayField(parsed.program, "body"),
				nextVisited
			)
		);
	};

	resolveImportedEntity = (
		name: AstNode,
		bindings: ImportBindings
	): ResolvedModuleSymbol | undefined => {
		if (name.type === "Identifier") {
			const localName = identifierName(name);
			if (localName === undefined) {
				return;
			}
			return (
				bindings.named.get(localName) ??
				(bindings.namespaces.has(localName)
					? {
							kind: "namespace",
							modulePath: bindings.namespaces.get(localName) as string,
						}
					: undefined)
			);
		}
		if (name.type !== "TSQualifiedName") {
			return;
		}
		const left = nodeField(name, "left");
		const rightName = exportName(nodeField(name, "right"));
		if (left === undefined || rightName === undefined) {
			return;
		}
		const namespace = this.resolveImportedEntity(left, bindings);
		return namespace?.kind === "namespace"
			? this.resolveExport(namespace.modulePath, rightName)
			: undefined;
	};

	resolveEntityFromModule = (
		modulePath: string,
		name: AstNode
	): ResolvedModuleSymbol | undefined => {
		if (name.type === "Identifier") {
			const exportedName = identifierName(name);
			return exportedName === undefined
				? undefined
				: this.resolveExport(modulePath, exportedName);
		}
		if (name.type !== "TSQualifiedName") {
			return;
		}
		const left = nodeField(name, "left");
		const rightName = exportName(nodeField(name, "right"));
		if (left === undefined || rightName === undefined) {
			return;
		}
		const namespaceName = identifierName(left);
		if (namespaceName === undefined) {
			return;
		}
		const namespace = this.resolveExport(modulePath, namespaceName);
		return namespace?.kind === "namespace"
			? this.resolveExport(namespace.modulePath, rightName)
			: undefined;
	};

	moduleExportsRestrictedSymbol = (
		modulePath: string
	): SessionStorageBoundarySymbol | undefined => {
		for (const symbol of RESTRICTED_SYMBOLS) {
			if (this.resolveExport(modulePath, symbol)?.kind === "restricted") {
				return symbol;
			}
		}
		return;
	};

	readonly #restrictedSymbolAt = (
		modulePath: string,
		exportedName: string
	): SessionStorageBoundarySymbol | undefined => {
		const relativePath = normalizePath(
			path.relative(this.#packageRoot, modulePath)
		);
		const symbol = RESTRICTED_SOURCE_PATHS[relativePath];
		return symbol === exportedName ? symbol : undefined;
	};

	readonly #sessionFacetAt = (
		modulePath: string,
		exportedName: string
	): SessionStorageFacetSymbol | undefined => {
		const relativePath = normalizePath(
			path.relative(this.#packageRoot, modulePath)
		);
		const symbol = SESSION_FACET_SOURCE_PATHS[relativePath];
		return symbol === exportedName ? symbol : undefined;
	};

	readonly #cacheResult = (
		cacheKey: string,
		result: ResolvedModuleSymbol | undefined
	): ResolvedModuleSymbol | undefined => {
		this.#cache.set(cacheKey, result ?? null);
		return result;
	};

	readonly #resolveExportStatements = (
		modulePath: string,
		exportedName: string,
		statements: readonly AstNode[],
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		for (const statement of statements) {
			const resolved = this.#resolveExportStatement(
				modulePath,
				statement,
				exportedName,
				visited
			);
			if (resolved !== undefined) {
				return resolved;
			}
		}
		return;
	};

	readonly #resolveExportStatement = (
		modulePath: string,
		statement: AstNode,
		exportedName: string,
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		switch (statement.type) {
			case "ExportAllDeclaration":
				return this.#resolveExportAll(
					modulePath,
					statement,
					exportedName,
					visited
				);
			case "ExportDefaultDeclaration":
				return this.#resolveExportDefault(
					modulePath,
					statement,
					exportedName,
					visited
				);
			case "ExportNamedDeclaration":
				return this.#resolveExportNamed(
					modulePath,
					statement,
					exportedName,
					visited
				);
			default:
				return;
		}
	};

	readonly #resolveExportAll = (
		modulePath: string,
		statement: AstNode,
		exportedName: string,
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		const targetSpecifier = sourceSpecifier(statement);
		if (targetSpecifier === undefined) {
			return;
		}
		const target = this.resolveModule(modulePath, targetSpecifier);
		if (target === undefined) {
			return;
		}
		const exportedNamespace = exportName(nodeField(statement, "exported"));
		if (exportedNamespace === exportedName) {
			return { kind: "namespace", modulePath: target };
		}
		if (exportedNamespace !== undefined) {
			return;
		}
		return this.resolveExport(target, exportedName, visited);
	};

	readonly #resolveExportDefault = (
		modulePath: string,
		statement: AstNode,
		exportedName: string,
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		if (exportedName !== "default") {
			return;
		}
		const localName = identifierName(nodeField(statement, "declaration"));
		return localName === undefined
			? undefined
			: this.#resolveLocalImport(modulePath, localName, visited);
	};

	readonly #resolveExportNamed = (
		modulePath: string,
		statement: AstNode,
		exportedName: string,
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		const source = sourceSpecifier(statement);
		const target =
			source === undefined ? undefined : this.resolveModule(modulePath, source);
		for (const specifier of nodeArrayField(statement, "specifiers")) {
			if (specifier.type !== "ExportSpecifier") {
				continue;
			}
			if (exportName(nodeField(specifier, "exported")) !== exportedName) {
				continue;
			}
			const localName = exportName(nodeField(specifier, "local"));
			if (localName === undefined) {
				continue;
			}
			const resolved =
				target === undefined
					? this.#resolveLocalImport(modulePath, localName, visited)
					: this.resolveExport(target, localName, visited);
			if (resolved !== undefined) {
				return resolved;
			}
		}
		return;
	};

	readonly #resolveLocalImport = (
		modulePath: string,
		localName: string,
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		const parsed = this.#sourceFiles.get(modulePath);
		if (parsed === undefined) {
			return;
		}
		for (const statement of nodeArrayField(parsed.program, "body")) {
			if (statement.type !== "ImportDeclaration") {
				continue;
			}
			const importSpecifier = sourceSpecifier(statement);
			if (importSpecifier === undefined) {
				continue;
			}
			const target = this.resolveModule(modulePath, importSpecifier);
			if (target === undefined) {
				continue;
			}
			const resolved = this.#resolveImportBinding(
				statement,
				target,
				localName,
				visited
			);
			if (resolved !== undefined) {
				return resolved;
			}
		}
		return;
	};

	readonly #resolveImportBinding = (
		statement: AstNode,
		target: string,
		localName: string,
		visited: ReadonlySet<string>
	): ResolvedModuleSymbol | undefined => {
		for (const specifier of nodeArrayField(statement, "specifiers")) {
			if (identifierName(nodeField(specifier, "local")) !== localName) {
				continue;
			}
			switch (specifier.type) {
				case "ImportNamespaceSpecifier":
					return { kind: "namespace", modulePath: target };
				case "ImportDefaultSpecifier":
					return this.resolveExport(target, "default", visited);
				case "ImportSpecifier":
					return this.resolveExport(
						target,
						exportName(nodeField(specifier, "imported")) ?? localName,
						visited
					);
				default:
					return;
			}
		}
		return;
	};
}

const bindImportSpecifier = (
	imported: AstNode,
	target: string,
	resolver: RestrictedExportResolver,
	named: Map<string, ResolvedModuleSymbol>,
	namespaces: Map<string, string>
): void => {
	const localName = identifierName(nodeField(imported, "local"));
	if (localName === undefined) {
		return;
	}
	if (imported.type === "ImportNamespaceSpecifier") {
		namespaces.set(localName, target);
		return;
	}
	let importedName: string | undefined;
	if (imported.type === "ImportDefaultSpecifier") {
		importedName = "default";
	} else if (imported.type === "ImportSpecifier") {
		importedName = exportName(nodeField(imported, "imported")) ?? localName;
	}
	if (importedName === undefined) {
		return;
	}
	const resolved = resolver.resolveExport(target, importedName);
	if (resolved !== undefined) {
		named.set(localName, resolved);
	}
};

const importBindingsFor = (
	filePath: string,
	program: AstNode,
	resolver: RestrictedExportResolver
): ImportBindings => {
	const named = new Map<string, ResolvedModuleSymbol>();
	const namespaces = new Map<string, string>();
	for (const statement of nodeArrayField(program, "body")) {
		if (statement.type !== "ImportDeclaration") {
			continue;
		}
		const specifier = sourceSpecifier(statement);
		if (specifier === undefined) {
			continue;
		}
		const target = resolver.resolveModule(filePath, specifier);
		if (target === undefined) {
			continue;
		}
		for (const imported of nodeArrayField(statement, "specifiers")) {
			bindImportSpecifier(imported, target, resolver, named, namespaces);
		}
	}
	return { named, namespaces };
};

const collectSessionFacetSymbols = (
	typeNode: AstNode,
	bindings: ImportBindings,
	filePath: string,
	resolver: RestrictedExportResolver,
	aliases: ReadonlyMap<string, AstNode>,
	visitedAliases: ReadonlySet<string> = new Set()
): Set<SessionStorageFacetSymbol> => {
	if (typeNode.type === "TSIntersectionType") {
		const facets = new Set<SessionStorageFacetSymbol>();
		for (const member of nodeArrayField(typeNode, "types")) {
			for (const facet of collectSessionFacetSymbols(
				member,
				bindings,
				filePath,
				resolver,
				aliases,
				visitedAliases
			)) {
				facets.add(facet);
			}
		}
		return facets;
	}
	if (typeNode.type === "TSImportType") {
		const resolved = resolveImportTypeNode(filePath, typeNode, resolver);
		return resolved?.kind === "facet" ? new Set([resolved.symbol]) : new Set();
	}
	if (typeNode.type !== "TSTypeReference") {
		return new Set();
	}
	const typeName = nodeField(typeNode, "typeName");
	if (typeName === undefined) {
		return new Set();
	}
	const resolved = resolver.resolveImportedEntity(typeName, bindings);
	if (resolved?.kind === "facet") {
		return new Set([resolved.symbol]);
	}
	const localName = identifierName(typeName);
	if (
		localName === undefined ||
		visitedAliases.has(localName) ||
		resolved !== undefined
	) {
		return new Set();
	}
	const alias = aliases.get(localName);
	const annotation =
		alias === undefined ? undefined : nodeField(alias, "typeAnnotation");
	return annotation === undefined
		? new Set()
		: collectSessionFacetSymbols(
				annotation,
				bindings,
				filePath,
				resolver,
				aliases,
				new Set(visitedAliases).add(localName)
			);
};

const isCompleteSessionFacetSet = (
	facets: ReadonlySet<SessionStorageFacetSymbol>
): boolean =>
	facets.size === SESSION_STORAGE_FACETS.size &&
	[...SESSION_STORAGE_FACETS].every((facet) => facets.has(facet));

const isAllowedFacetAggregate = (
	relativePackagePath: string,
	ancestors: readonly AstNode[]
): boolean =>
	(relativePackagePath === "modules/sessions/storage/session-storage.ts" &&
		typeAliasName(ancestors) === "SessionStorage") ||
	Object.hasOwn(AGGREGATE_TEST_FILES, relativePackagePath);

const createFinding = (
	root: string,
	filePath: string,
	source: ParsedSource,
	node: AstNode,
	symbol: SessionStorageBoundarySymbol
): SessionStorageBoundaryFinding => ({
	expectation: restrictedExpectation(symbol),
	file: normalizePath(path.relative(root, filePath)),
	line: lineOf(source, node),
	restrictedSymbol: symbol,
});

const allowedAggregateUse = (
	relativePackagePath: string,
	ancestors: readonly AstNode[]
): boolean =>
	Object.hasOwn(AGGREGATE_TEST_FILES, relativePackagePath) ||
	isAllowedAggregateTypeUse(relativePackagePath, ancestors);

const isAllowedTestReexport = (
	relativePackagePath: string,
	symbol: SessionStorageBoundarySymbol
): boolean =>
	symbol === "SessionStorage"
		? Object.hasOwn(AGGREGATE_TEST_FILES, relativePackagePath) ||
			Object.hasOwn(AGGREGATE_ASSEMBLY_FILES, relativePackagePath)
		: isAllowedRestrictedImport(relativePackagePath, symbol);

const parseSource = (filePath: string, sourceText: string): ParsedSource => {
	const parsed = parse(sourceText, {
		locations: true,
		plugins: [
			"typescript",
			...(filePath.endsWith(".tsx") ? ["jsx" as const] : []),
			"decorators-legacy",
		],
		sourceFilename: filePath,
		sourceType: "unambiguous",
	});
	const parsedRoot = asAstNode(parsed);
	const program =
		parsedRoot === undefined ? undefined : nodeField(parsedRoot, "program");
	if (program === undefined) {
		throw new Error(
			`Parser did not return a TypeScript program for ${filePath}.`
		);
	}
	return { program, sourceText };
};

type BoundaryFindingSink = (
	filePath: string,
	source: ParsedSource,
	node: AstNode,
	symbol: SessionStorageBoundarySymbol
) => void;

type BoundaryScanContext = Readonly<{
	packageRoot: string;
	resolver: RestrictedExportResolver;
	addFinding: BoundaryFindingSink;
}>;

const scanImportDeclaration = (
	filePath: string,
	relativePackagePath: string,
	source: ParsedSource,
	statement: AstNode,
	bindings: ImportBindings,
	context: BoundaryScanContext
): void => {
	const specifier = sourceSpecifier(statement);
	if (specifier === undefined) {
		return;
	}
	const target = context.resolver.resolveModule(filePath, specifier);
	if (target === undefined) {
		return;
	}
	for (const imported of nodeArrayField(statement, "specifiers")) {
		const localName = identifierName(nodeField(imported, "local"));
		if (localName === undefined) {
			continue;
		}
		const resolved = bindings.named.get(localName);
		if (
			resolved?.kind !== "restricted" ||
			isAllowedRestrictedImport(relativePackagePath, resolved.symbol)
		) {
			continue;
		}
		context.addFinding(filePath, source, imported, resolved.symbol);
	}
};

const symbolsExportedBy = (
	resolver: RestrictedExportResolver,
	target: string
): SessionStorageBoundarySymbol[] =>
	RESTRICTED_SYMBOLS.filter(
		(symbol) => resolver.resolveExport(target, symbol)?.kind === "restricted"
	);

const scanExportAllDeclaration = (
	relativePackagePath: string,
	source: ParsedSource,
	statement: AstNode,
	context: BoundaryScanContext
): void => {
	const specifier = sourceSpecifier(statement);
	if (specifier === undefined) {
		return;
	}
	const target = context.resolver.resolveModule(
		path.resolve(context.packageRoot, relativePackagePath),
		specifier
	);
	if (target === undefined) {
		return;
	}
	const namespace = exportName(nodeField(statement, "exported"));
	const symbols =
		namespace === undefined
			? symbolsExportedBy(context.resolver, target)
			: [context.resolver.moduleExportsRestrictedSymbol(target)].filter(
					(symbol): symbol is SessionStorageBoundarySymbol =>
						symbol !== undefined
				);
	for (const symbol of symbols) {
		if (isAllowedTestReexport(relativePackagePath, symbol)) {
			continue;
		}
		context.addFinding(
			path.resolve(context.packageRoot, relativePackagePath),
			source,
			statement,
			symbol
		);
	}
};

const scanExportNamedDeclaration = (
	filePath: string,
	relativePackagePath: string,
	source: ParsedSource,
	statement: AstNode,
	context: BoundaryScanContext
): void => {
	const specifier = sourceSpecifier(statement);
	const target =
		specifier === undefined
			? undefined
			: context.resolver.resolveModule(filePath, specifier);
	for (const exported of nodeArrayField(statement, "specifiers")) {
		if (exported.type !== "ExportSpecifier") {
			continue;
		}
		const sourceName = exportName(nodeField(exported, "local"));
		if (sourceName === undefined) {
			continue;
		}
		const resolved =
			target === undefined
				? context.resolver.resolveExport(filePath, sourceName)
				: context.resolver.resolveExport(target, sourceName);
		if (
			resolved?.kind !== "restricted" ||
			isAllowedTestReexport(relativePackagePath, resolved.symbol)
		) {
			continue;
		}
		context.addFinding(filePath, source, exported, resolved.symbol);
	}
};

const scanModuleDeclarations = (
	filePath: string,
	relativePackagePath: string,
	source: ParsedSource,
	bindings: ImportBindings,
	context: BoundaryScanContext
): void => {
	for (const statement of nodeArrayField(source.program, "body")) {
		switch (statement.type) {
			case "ImportDeclaration":
				scanImportDeclaration(
					filePath,
					relativePackagePath,
					source,
					statement,
					bindings,
					context
				);
				break;
			case "ExportAllDeclaration":
				scanExportAllDeclaration(
					relativePackagePath,
					source,
					statement,
					context
				);
				break;
			case "ExportNamedDeclaration":
				scanExportNamedDeclaration(
					filePath,
					relativePackagePath,
					source,
					statement,
					context
				);
				break;
			default:
				break;
		}
	}
};

const resolveImportTypeNode = (
	filePath: string,
	node: AstNode,
	resolver: RestrictedExportResolver
): ResolvedModuleSymbol | undefined => {
	const moduleName = stringLiteralValue(nodeField(node, "argument"));
	if (moduleName === undefined) {
		return;
	}
	const modulePath = resolver.resolveModule(filePath, moduleName);
	if (modulePath === undefined) {
		return;
	}
	const qualifier = nodeField(node, "qualifier");
	if (qualifier !== undefined) {
		return resolver.resolveEntityFromModule(modulePath, qualifier);
	}
	const symbol = resolver.moduleExportsRestrictedSymbol(modulePath);
	return symbol === undefined ? undefined : { kind: "restricted", symbol };
};

const resolveNamespaceMember = (
	node: AstNode,
	bindings: ImportBindings,
	resolver: RestrictedExportResolver
): ResolvedModuleSymbol | undefined => {
	const namespaceName = identifierName(nodeField(node, "object"));
	const propertyName = exportName(nodeField(node, "property"));
	if (namespaceName === undefined || propertyName === undefined) {
		return;
	}
	const imported = bindings.named.get(namespaceName);
	const namespacePath =
		bindings.namespaces.get(namespaceName) ??
		(imported?.kind === "namespace" ? imported.modulePath : undefined);
	return namespacePath === undefined
		? undefined
		: resolver.resolveExport(namespacePath, propertyName);
};

const resolveImportedName = (
	node: AstNode,
	field: string,
	bindings: ImportBindings,
	resolver: RestrictedExportResolver
): ResolvedModuleSymbol | undefined => {
	const name = nodeField(node, field);
	return name === undefined
		? undefined
		: resolver.resolveImportedEntity(name, bindings);
};

const resolveRestrictedSymbolForNode = (
	node: AstNode,
	bindings: ImportBindings,
	filePath: string,
	resolver: RestrictedExportResolver
): ResolvedModuleSymbol | undefined => {
	switch (node.type) {
		case "TSTypeReference":
			return resolveImportedName(node, "typeName", bindings, resolver);
		case "TSExpressionWithTypeArguments":
			return resolveImportedName(node, "expression", bindings, resolver);
		case "TSImportType":
			return resolveImportTypeNode(filePath, node, resolver);
		case "TSTypeQuery":
			return resolveImportedName(node, "exprName", bindings, resolver);
		case "MemberExpression":
			return resolveNamespaceMember(node, bindings, resolver);
		default:
			return;
	}
};

const isAllowedResolvedUse = (
	symbol: SessionStorageBoundarySymbol,
	relativePackagePath: string,
	ancestors: readonly AstNode[]
): boolean =>
	symbol === "SessionStorage"
		? allowedAggregateUse(relativePackagePath, ancestors)
		: isAllowedRestrictedImport(relativePackagePath, symbol);

const visitSourceNode = (
	node: AstNode,
	ancestors: readonly AstNode[],
	filePath: string,
	relativePackagePath: string,
	source: ParsedSource,
	bindings: ImportBindings,
	aliases: ReadonlyMap<string, AstNode>,
	context: BoundaryScanContext
): void => {
	const currentAncestors = [...ancestors, node];
	if (
		node.type === "TSIntersectionType" &&
		isCompleteSessionFacetSet(
			collectSessionFacetSymbols(
				node,
				bindings,
				filePath,
				context.resolver,
				aliases
			)
		) &&
		!isAllowedFacetAggregate(relativePackagePath, currentAncestors)
	) {
		context.addFinding(filePath, source, node, "SessionStorage");
	}
	const resolved = resolveRestrictedSymbolForNode(
		node,
		bindings,
		filePath,
		context.resolver
	);
	if (
		resolved?.kind === "restricted" &&
		!isAllowedResolvedUse(
			resolved.symbol,
			relativePackagePath,
			currentAncestors
		)
	) {
		context.addFinding(filePath, source, node, resolved.symbol);
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) {
				const childNode = asAstNode(child);
				if (childNode !== undefined) {
					visitSourceNode(
						childNode,
						currentAncestors,
						filePath,
						relativePackagePath,
						source,
						bindings,
						aliases,
						context
					);
				}
			}
			continue;
		}
		const childNode = asAstNode(value);
		if (childNode !== undefined) {
			visitSourceNode(
				childNode,
				currentAncestors,
				filePath,
				relativePackagePath,
				source,
				bindings,
				aliases,
				context
			);
		}
	}
};

const scanSourceFile = (
	filePath: string,
	source: ParsedSource,
	context: BoundaryScanContext
): void => {
	const relativePackagePath = normalizePath(
		path.relative(context.packageRoot, filePath)
	);
	const bindings = importBindingsFor(
		filePath,
		source.program,
		context.resolver
	);
	const aliases = localTypeAliases(source.program);
	scanModuleDeclarations(
		filePath,
		relativePackagePath,
		source,
		bindings,
		context
	);
	visitSourceNode(
		source.program,
		[],
		filePath,
		relativePackagePath,
		source,
		bindings,
		aliases,
		context
	);
};

const parsePackageSourceFiles = (
	absoluteRoot: string,
	packageRoot: string
): Map<string, ParsedSource> => {
	let packageRootStats: fs.Stats | undefined;
	try {
		packageRootStats = fs.statSync(packageRoot);
	} catch (error) {
		if (!isMissingPathError(error)) {
			throw error;
		}
	}
	if (packageRootStats === undefined || !packageRootStats.isDirectory()) {
		throw new Error(
			`Expected a Coding Agent package directory at ${packageRoot}.`
		);
	}
	const filePaths: string[] = [];
	walkSourceFiles(packageRoot, "", filePaths);
	if (filePaths.length === 0) {
		throw new Error(`No TypeScript source files found under ${packageRoot}.`);
	}
	const sourceFiles = new Map<string, ParsedSource>();
	for (const filePath of filePaths) {
		const sourceText = fs.readFileSync(filePath, "utf8");
		try {
			sourceFiles.set(filePath, parseSource(filePath, sourceText));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const relativePath = normalizePath(path.relative(absoluteRoot, filePath));
			throw new Error(`Could not parse ${relativePath}: ${message}`);
		}
	}
	return sourceFiles;
};

const compareBoundaryFindings = (
	left: SessionStorageBoundaryFinding,
	right: SessionStorageBoundaryFinding
): number => {
	const fileOrder = left.file.localeCompare(right.file);
	if (fileOrder !== 0) {
		return fileOrder;
	}
	const lineOrder = left.line - right.line;
	return lineOrder === 0
		? left.restrictedSymbol.localeCompare(right.restrictedSymbol)
		: lineOrder;
};

export const checkSessionStorageBoundaries = (
	root: string
): SessionStorageBoundaryReport => {
	const absoluteRoot = path.resolve(root);
	const packageRoot = path.join(absoluteRoot, "packages", "coding-agent");
	const sourceFiles = parsePackageSourceFiles(absoluteRoot, packageRoot);
	const resolver = new RestrictedExportResolver(packageRoot, sourceFiles);
	const findingsByKey = new Map<string, SessionStorageBoundaryFinding>();
	const context: BoundaryScanContext = {
		packageRoot,
		resolver,
		addFinding: (filePath, source, node, symbol) => {
			const finding = createFinding(
				absoluteRoot,
				filePath,
				source,
				node,
				symbol
			);
			const key = `${finding.file}:${finding.line}:${finding.restrictedSymbol}`;
			findingsByKey.set(key, finding);
		},
	};
	for (const [filePath, source] of sourceFiles) {
		scanSourceFile(filePath, source, context);
	}
	const findings = [...findingsByKey.values()].sort(compareBoundaryFindings);
	return { findings, scannedFiles: sourceFiles.size };
};

export const formatSessionStorageBoundaryReport = (
	report: SessionStorageBoundaryReport
): string => {
	if (report.findings.length === 0) {
		return `Session storage boundaries hold across ${report.scannedFiles} TypeScript files.`;
	}
	const lines = [
		`Session storage boundary check found ${report.findings.length} violation(s) across ${report.scannedFiles} TypeScript files:`,
	];
	for (const finding of report.findings) {
		lines.push(
			`  ${finding.file}:${finding.line}: ${finding.restrictedSymbol} — ${finding.expectation}`
		);
	}
	return lines.join("\n");
};

const rootArgument = (argv: readonly string[]): string => {
	const rootIndex = argv.indexOf("--root");
	if (rootIndex < 0) {
		return process.cwd();
	}
	const root = argv[rootIndex + 1];
	if (root === undefined) {
		throw new Error("--root requires a project directory.");
	}
	return path.resolve(process.cwd(), root);
};

if (import.meta.main) {
	try {
		const report = checkSessionStorageBoundaries(
			rootArgument(process.argv.slice(2))
		);
		process.stdout.write(`${formatSessionStorageBoundaryReport(report)}\n`);
		process.exit(report.findings.length === 0 ? 0 : 1);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exit(1);
	}
}
