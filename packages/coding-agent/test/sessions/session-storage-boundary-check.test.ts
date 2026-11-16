import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkSessionStorageBoundaries,
	formatSessionStorageBoundaryReport,
} from "../../../../scripts/session-storage-boundary-check";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const fixtureRoots: string[] = [];

const createFixtureRoot = (): string => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "session-storage-boundary-")
	);
	fixtureRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

const writeSource = (
	root: string,
	relativePath: string,
	source: string
): void => {
	const filePath = path.join(root, "packages", "coding-agent", relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, source);
};

const findingsFor = (files: Readonly<Record<string, string>>) => {
	const root = createFixtureRoot();
	for (const [relativePath, source] of Object.entries(files)) {
		writeSource(root, relativePath, source);
	}
	return checkSessionStorageBoundaries(root).findings;
};

const aggregateDefinition = `export type SessionStorage = Readonly<{ listSessionsPage: () => Promise<void> }>;
`;

const sessionServicesAssembly = `import type { SessionStorage } from "../storage/session-storage";
export type SessionServicesSources = Readonly<{ storage?: () => SessionStorage }>;
export type SessionServices = Readonly<{ storage: SessionStorage }>;
`;
const sessionFacetDefinitions = {
	"modules/sessions/storage/session-records.ts": `export type SessionRecords = Readonly<{ records: true }>;
`,
	"modules/sessions/storage/session-catalog.ts": `export type SessionCatalog = Readonly<{ catalog: true }>;
`,
	"modules/sessions/storage/session-history.ts": `export type SessionHistory = Readonly<{ history: true }>;
`,
	"modules/sessions/storage/session-lifecycle.ts": `export type SessionLifecycle = Readonly<{ lifecycle: true }>;
`,
	"modules/sessions/storage/session-attachments.ts": `export type SessionAttachments = Readonly<{ attachments: true }>;
`,
	"modules/sessions/storage/plugin-session-state.ts": `export type PluginSessionState = Readonly<{ pluginState: true }>;
`,
};

test("the check fails closed when the package root is missing or empty", () => {
	const missingRoot = createFixtureRoot();
	expect(() => checkSessionStorageBoundaries(missingRoot)).toThrow(
		"Expected a Coding Agent package directory"
	);

	const emptyRoot = createFixtureRoot();
	fs.mkdirSync(path.join(emptyRoot, "packages", "coding-agent"), {
		recursive: true,
	});
	expect(() => checkSessionStorageBoundaries(emptyRoot)).toThrow(
		"No TypeScript source files found"
	);
});

test("accepts named storage assembly contracts and explicit composition fixtures", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-storage.ts": aggregateDefinition,
		"modules/sessions/host/session-services.ts": sessionServicesAssembly,
		"modules/sessions/host/types.ts": `import type { SessionStorage } from "../storage/session-storage";
export type SessionHostOptions = Readonly<{ storage: SessionStorage }>;
`,
		"modules/sessions/sdk.ts": `import type { SessionStorage } from "./storage/session-storage";
type SharedSessionSdkResources = Readonly<{ storage: SessionStorage }>;
export const createSessionSdkRuntimeFactory = (storage: SessionStorage) => storage;
`,
		"test/support/session-facets/storage.ts": `import type { SessionStorage } from "../../../modules/sessions/storage/session-storage";
export const fixture = (storage: SessionStorage): SessionStorage => storage;
`,
		"test/sessions/session-record.test.ts": `import type { SessionProjection } from "../../modules/sessions/storage/session-projection";
export const projectionFixture = (projection: SessionProjection): SessionProjection => projection;
`,
		"test/sessions/session-plugin-state.test.ts": `import type { SessionStorage } from "../../modules/sessions/storage/session-storage";
export const composeRuntime = (storage: SessionStorage): SessionStorage => storage;
`,
		"modules/sessions/storage/session-projection.ts": `export type SessionProjection = Readonly<{ list: () => void }>;
`,
	});

	expect(findings).toEqual([]);
});

test("attachment storage is available only at named Session composition roots", () => {
	const findings = findingsFor({
		"modules/sessions/storage/attachment-store.ts": `export type SessionAttachmentStore = Readonly<{ collect: () => void }>;
`,
		"modules/sessions/storage/session-storage.ts": aggregateDefinition,
		"scripts/session-jsonl-benchmark.ts": `import type { SessionAttachmentStore } from "@/modules/sessions/storage/attachment-store";
export const benchmark = (attachments: SessionAttachmentStore) => attachments.collect();
`,
		"test/support/session-jsonl-storage.ts": `import type { SessionStorage } from "../../modules/sessions/storage/session-storage";
import type { SessionAttachmentStore } from "../../modules/sessions/storage/attachment-store";
export const fixture = (storage: SessionStorage, attachments: SessionAttachmentStore) => [storage, attachments];
`,
		"modules/sessions/ui/session-picker.ts": `import type { SessionAttachmentStore } from "@/modules/sessions/storage/attachment-store";
export const collect = (attachments: SessionAttachmentStore) => attachments.collect();
`,
	});

	expect(findings.length).toBeGreaterThan(0);
	expect(
		findings.every(
			({ file, restrictedSymbol }) =>
				file ===
					"packages/coding-agent/modules/sessions/ui/session-picker.ts" &&
				restrictedSymbol === "SessionAttachmentStore"
		)
	).toBe(true);
});

test("rejects an ordinary aggregate consumer even when it aliases the import", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-storage.ts": aggregateDefinition,
		"modules/sessions/ui/session-picker.ts": `import type { SessionStorage as Store } from "@/modules/sessions/storage/session-storage";
export const listSessions = (storage: Store) => storage.listSessionsPage();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({
			file: "packages/coding-agent/modules/sessions/ui/session-picker.ts",
			restrictedSymbol: "SessionStorage",
		})
	);
});

test("rejects an ordinary alias that recombines all six facets", () => {
	const findings = findingsFor({
		...sessionFacetDefinitions,
		"modules/sessions/storage/session-facets.ts": `export type { SessionRecords as Records } from "./session-records";
export type { SessionCatalog as Catalog } from "./session-catalog";
export type { SessionHistory as History } from "./session-history";
export type { SessionLifecycle as Lifecycle } from "./session-lifecycle";
export type { SessionAttachments as Attachments } from "./session-attachments";
export type { PluginSessionState as PluginState } from "./plugin-session-state";
`,
		"modules/sessions/agent-session/rebuilt-storage.ts": `import type { Records, Catalog, History, Lifecycle, Attachments, PluginState } from "../storage/session-facets";
type RecordsAndCatalog = Records & Catalog;
export type ReassembledSessionStorage = RecordsAndCatalog & History & Lifecycle & Attachments & PluginState;
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({
			file: "packages/coding-agent/modules/sessions/agent-session/rebuilt-storage.ts",
			restrictedSymbol: "SessionStorage",
		})
	);
});

test("rejects an aggregate dependency on the SDK operation factory", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-storage.ts": aggregateDefinition,
		"modules/sessions/sdk.ts": `import type { SessionStorage } from "./storage/session-storage";
export const createSessionSdkOperations = (storage: SessionStorage) => storage.listSessionsPage();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({
			file: "packages/coding-agent/modules/sessions/sdk.ts",
			restrictedSymbol: "SessionStorage",
		})
	);
});

test("rejects an aggregate-typed business helper inside an assembly module", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-storage.ts": aggregateDefinition,
		"modules/sessions/host/session-services.ts": `${sessionServicesAssembly}
const renameSession = (storage: SessionStorage): Promise<void> => storage.listSessionsPage();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({
			file: "packages/coding-agent/modules/sessions/host/session-services.ts",
			restrictedSymbol: "SessionStorage",
		})
	);
});

test("rejects the internal projection interface outside storage", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-projection.ts": `export type SessionProjection = Readonly<{ list: () => void }>;
`,
		"modules/sessions/agent-session/rebuild.ts": `import type { SessionProjection } from "../storage/session-projection";
export const rebuild = (projection: SessionProjection) => projection.list();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({
			file: "packages/coding-agent/modules/sessions/agent-session/rebuild.ts",
			restrictedSymbol: "SessionProjection",
		})
	);
});

test("rejects namespace access to the internal projection interface", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-projection.ts": `export type SessionProjection = Readonly<{ list: () => void }>;
`,
		"modules/sessions/agent-session/rebuild.ts": `import type * as Storage from "../storage/session-projection";
export const rebuild = (projection: Storage.SessionProjection) => projection.list();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({ restrictedSymbol: "SessionProjection" })
	);
});

test("rejects the projection interface through a local barrel re-export", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-projection.ts": `export type SessionProjection = Readonly<{ list: () => void }>;
`,
		"modules/sessions/storage/projection-barrel.ts": `export type { SessionProjection as InternalProjection } from "./session-projection";
`,
		"modules/sessions/agent-session/rebuild.ts": `import type { InternalProjection } from "../storage/projection-barrel";
export const rebuild = (projection: InternalProjection) => projection.list();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({ restrictedSymbol: "SessionProjection" })
	);
});

test("ignores comments, strings, and unrelated similarly named types", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-projection.ts": `export type SessionProjection = Readonly<{ list: () => void }>;
export type SessionProjectionCursor = Readonly<{ sequence: number }>;
`,
		"modules/sessions/agent-session/metadata.ts": `// SessionStorage and SessionProjection are not dependencies here.
import type { SessionProjectionCursor } from "../storage/session-projection";
export type SessionProjectionStatus = "ready" | "blocked";
export const note = "SessionStorage SessionProjection";
export const cursor = (value: SessionProjectionCursor): number => value.sequence;
`,
	});

	expect(findings).toEqual([]);
});

test("does not blanket-exempt unrelated test consumers from aggregate restrictions", () => {
	const findings = findingsFor({
		"modules/sessions/storage/session-storage.ts": aggregateDefinition,
		"test/sessions/session-picker.test.ts": `import type { SessionStorage } from "../../modules/sessions/storage/session-storage";
export const listSessions = (storage: SessionStorage) => storage.listSessionsPage();
`,
	});

	expect(findings).toContainEqual(
		expect.objectContaining({
			file: "packages/coding-agent/test/sessions/session-picker.test.ts",
			restrictedSymbol: "SessionStorage",
		})
	);
});

test("the check command reports and exits nonzero for a forbidden dependency", () => {
	const root = createFixtureRoot();
	writeSource(
		root,
		"modules/sessions/storage/session-storage.ts",
		aggregateDefinition
	);
	writeSource(
		root,
		"modules/sessions/ui/session-picker.ts",
		`import type { SessionStorage } from "../storage/session-storage";\nexport const list = (storage: SessionStorage) => storage.listSessionsPage();\n`
	);
	const command = Bun.spawnSync(
		[
			"bun",
			"--no-env-file",
			path.join(repoRoot, "scripts", "session-storage-boundary-check.ts"),
			"--root",
			root,
		],
		{ cwd: repoRoot, stderr: "pipe", stdout: "pipe" }
	);

	expect(command.exitCode).toBe(1);
	expect(command.stdout.toString()).toContain("SessionStorage");
	expect(command.stdout.toString()).toContain("session-picker.ts");
});

test("the repository satisfies the declared Session storage boundaries", () => {
	const report = checkSessionStorageBoundaries(repoRoot);

	expect(report.findings).toEqual([]);
	expect(formatSessionStorageBoundaryReport(report)).toContain(
		"Session storage boundaries hold"
	);
});
