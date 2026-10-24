import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isUndefined } from "@wincode/utils";
import { createConfigStore as createConfigStoreImplementation } from "@/shared/config/config-store";

const CONFIG_ROOT = "/home/user/.config/wincode";
const HOME_ROOT = "/home/user";
const WORKSPACE = "/workspace";

const createConfigStore = (
	options: Parameters<typeof createConfigStoreImplementation>[0] = {}
) =>
	createConfigStoreImplementation({
		...options,
		trustedProjectRoots: options.trustedProjectRoots ?? [WORKSPACE],
	});

const fileSystem = (files: Record<string, string>, reads?: string[]) => ({
	readFile: async (file: string): Promise<string> => {
		reads?.push(file);
		const value = files[file];
		if (isUndefined(value)) {
			const error = new Error("missing") as Error & { code: string };
			error.code = "ENOENT";
			throw error;
		}
		return value;
	},
});

describe("createConfigStore", () => {
	test("publishes refreshed and persisted settings to workspace observers without rereading during render", async () => {
		const settingsPath = `${HOME_ROOT}/.wincode/settings.json`;
		const files: Record<string, string> = {
			[settingsPath]: '{"contextWindowTokens":96000}',
		};
		const reads: string[] = [];
		const store = createConfigStore({
			fs: {
				...fileSystem(files, reads),
				writeFile: async (file, contents) => {
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});
		const observed: unknown[] = [];
		const unsubscribe = store.subscribeSnapshot(WORKSPACE, () => {
			observed.push(
				store.readSnapshot(WORKSPACE)?.document.contextWindowTokens
			);
		});
		expect(store.readSnapshot(WORKSPACE)).toBeUndefined();
		const initial = await store.getSnapshot(WORKSPACE);
		expect(store.readSnapshot(WORKSPACE)).toBe(initial);
		const readCount = reads.length;
		store.readSnapshot(WORKSPACE);
		expect(reads).toHaveLength(readCount);

		files[settingsPath] = '{"contextWindowTokens":100000}';
		await store.refreshSnapshot(WORKSPACE);
		await store.setValue(WORKSPACE, "global", ["contextWindowTokens"], 120_000);
		expect(observed).toEqual([96_000, 100_000, 120_000]);
		unsubscribe();
		await store.refreshSnapshot(WORKSPACE);
		expect(observed).toEqual([96_000, 100_000, 120_000]);
	});

	test("a slower superseded config load cannot overwrite a newer published snapshot", async () => {
		const firstRead = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		const settingsPath = `${HOME_ROOT}/.wincode/settings.json`;
		let reads = 0;
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					if (file !== settingsPath) {
						throw Object.assign(new Error("missing"), { code: "ENOENT" });
					}
					reads += 1;
					if (reads === 1) {
						started.resolve();
						return firstRead.promise;
					}
					return '{"contextWindowTokens":100000}';
				},
			},
			homeRoot: HOME_ROOT,
		});
		const oldLoad = store.getSnapshot(WORKSPACE);
		await started.promise;
		const latest = await store.refreshSnapshot(WORKSPACE);
		firstRead.resolve('{"contextWindowTokens":96000}');
		await oldLoad;
		expect(store.readSnapshot(WORKSPACE)).toBe(latest);
		expect(
			(await store.getSnapshot(WORKSPACE)).document.contextWindowTokens
		).toBe(100_000);
	});

	test("loads settings only from trusted .wincode scopes and prefers settings.jsonc", async () => {
		const userJsonPath = `${HOME_ROOT}/.wincode/settings.json`;
		const userJsoncPath = `${HOME_ROOT}/.wincode/settings.jsonc`;
		const projectJsonPath = `${WORKSPACE}/.wincode/settings.json`;
		const projectJsoncPath = `${WORKSPACE}/.wincode/settings.jsonc`;
		const store = createConfigStore({
			fs: fileSystem({
				[`${CONFIG_ROOT}/wincode.json`]: '{"legacyXdg":true}',
				[`${WORKSPACE}/wincode.json`]: '{"legacyProject":true}',
				[`${WORKSPACE}/settings.json`]: '{"rootProject":true}',
				[userJsonPath]: '{"userJson":true}',
				[userJsoncPath]: '{// JSONC takes precedence\n"userJsonc":true,}',
				[projectJsonPath]: '{"projectJson":true}',
				[projectJsoncPath]: '{"projectJsonc":true,}',
			}),
			homeRoot: HOME_ROOT,
			trustedProjectRoots: [WORKSPACE],
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({ userJsonc: true, projectJsonc: true });
		expect(snapshot.sources.map(({ path }) => path)).toEqual([
			userJsoncPath,
			projectJsoncPath,
		]);
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				{
					code: "duplicate-config",
					message: `Ignored duplicate config ${userJsonPath}`,
					path: userJsoncPath,
					scope: "global",
				},
				{
					code: "duplicate-config",
					message: `Ignored duplicate config ${projectJsonPath}`,
					path: projectJsoncPath,
					scope: "project",
				},
			])
		);
	});

	test("does not load project settings until that project is trusted", async () => {
		const store = createConfigStore({
			fs: fileSystem({
				[`${HOME_ROOT}/.wincode/settings.json`]: '{"userSetting":true}',
				[`${WORKSPACE}/.wincode/settings.json`]: '{"projectSetting":true}',
			}),
			homeRoot: HOME_ROOT,
			trustedProjectRoots: [],
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({ userSetting: true });
		expect(snapshot.sources.map(({ scope }) => scope)).toEqual(["global"]);
	});

	test("reads and persists a namespace without crossing its file boundary", async () => {
		const userMcpPath = `${HOME_ROOT}/.wincode/mcp.json`;
		const projectMcpPath = `${WORKSPACE}/.wincode/mcp.json`;
		const projectSettingsPath = `${WORKSPACE}/.wincode/settings.json`;
		const files: Record<string, string> = {
			[userMcpPath]:
				'{"mcpServers":{"shared":{"url":"https://user.test/mcp"}}}',
			[projectMcpPath]: '{"mcpServers":{"shared":{"enabled":false}}}',
			[projectSettingsPath]: '{"default_agent":"builder"}',
		};
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
						throw Object.assign(new Error("missing"), { code: "ENOENT" });
					}
					return value;
				},
				writeFile: async (file, contents) => {
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getNamespaceSnapshot(WORKSPACE, "mcp");
		await store.setNamespaceValue(
			WORKSPACE,
			"project",
			"mcp",
			["mcpServers", "shared", "enabled"],
			true,
			projectMcpPath
		);

		expect(snapshot.sources.map(({ path }) => path)).toEqual([
			userMcpPath,
			projectMcpPath,
		]);
		expect(JSON.parse(files[projectMcpPath] ?? "{}")).toEqual({
			mcpServers: { shared: { enabled: true } },
		});
		expect(files[projectSettingsPath]).toBe('{"default_agent":"builder"}');
	});

	test("rejects namespace writes outside the owning config sources", async () => {
		const projectMcpPath = `${WORKSPACE}/.wincode/mcp.json`;
		const files: Record<string, string> = {
			[projectMcpPath]: '{"mcpServers":{"shared":{"enabled":false}}}',
		};
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
						throw Object.assign(new Error("missing"), { code: "ENOENT" });
					}
					return value;
				},
				writeFile: async (file, contents) => {
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		await expect(
			store.setNamespaceValue(
				WORKSPACE,
				"project",
				"mcp",
				["mcpServers", "shared", "enabled"],
				true,
				"/tmp/unowned-mcp.json"
			)
		).rejects.toThrow("Could not resolve project config file.");
		expect(files[projectMcpPath]).toBe(
			'{"mcpServers":{"shared":{"enabled":false}}}'
		);
	});

	test("recursively merges user and trusted project settings with provenance", async () => {
		const userPath = `${HOME_ROOT}/.wincode/settings.json`;
		const projectPath = `${WORKSPACE}/.wincode/settings.json`;
		const store = createConfigStore({
			fs: fileSystem({
				[userPath]: JSON.stringify({
					settings: {
						profile: {
							metadata: { global: true, shared: "user" },
							tags: ["user"],
						},
					},
				}),
				[projectPath]: JSON.stringify({
					settings: {
						profile: {
							enabled: false,
							metadata: { shared: "project" },
							tags: ["project"],
						},
					},
				}),
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({
			settings: {
				profile: {
					enabled: false,
					metadata: { global: true, shared: "project" },
					tags: ["project"],
				},
			},
		});
		expect(
			snapshot.sourceFor(["settings", "profile", "metadata", "global"])
		).toEqual({ path: userPath, scope: "global" });
		expect(
			snapshot.sourceFor(["settings", "profile", "metadata", "shared"])
		).toEqual({ path: projectPath, scope: "project" });
		expect(snapshot.sourceFor(["settings", "profile", "enabled"])).toEqual({
			path: projectPath,
			scope: "project",
		});
		expect(
			snapshot.sources.map(({ path, scope }) => ({ path, scope }))
		).toEqual([
			{ path: userPath, scope: "global" },
			{ path: projectPath, scope: "project" },
		]);
	});

	test("prefers JSONC and reports a duplicate JSON document", async () => {
		const jsonPath = `${WORKSPACE}/.wincode/settings.json`;
		const jsoncPath = `${WORKSPACE}/.wincode/settings.jsonc`;
		const store = createConfigStore({
			fs: fileSystem({
				[jsonPath]: '{"settings":{"format":"json"}}',
				[jsoncPath]: '{// JSONC wins\n"settings":{"format":"jsonc",},}',
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({
			settings: { format: "jsonc" },
		});
		expect(snapshot.diagnostics).toContainEqual({
			code: "duplicate-config",
			message: `Ignored duplicate config ${jsonPath}`,
			path: jsoncPath,
			scope: "project",
		});
	});

	test("isolates malformed documents and unsafe prototype keys", async () => {
		const malformedPath = `${HOME_ROOT}/.wincode/settings.json`;
		const unsafePath = `${WORKSPACE}/.wincode/settings.json`;
		const store = createConfigStore({
			fs: fileSystem({
				[malformedPath]: '{"settings":',
				[unsafePath]: '{"constructor":{}}',
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({});
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				{
					code: "parse-error",
					message: `Could not parse ${malformedPath}`,
					path: malformedPath,
					scope: "global",
				},
				{
					code: "unsafe-key",
					message: "Unsafe config key constructor",
					path: unsafePath,
					scope: "project",
				},
			])
		);
	});

	test("isolates unreadable config sources with a diagnostic", async () => {
		const unreadablePath = `${HOME_ROOT}/.wincode/settings.jsonc`;
		const files = {
			[`${WORKSPACE}/.wincode/settings.json`]: '{"settings":{"valid":true}}',
		};
		const fallback = fileSystem(files);
		const store = createConfigStore({
			fs: {
				readFile: async (file): Promise<string> => {
					if (file === unreadablePath) {
						const error = new Error("denied") as Error & { code: string };
						error.code = "EACCES";
						throw error;
					}
					return fallback.readFile(file);
				},
			},
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({ settings: { valid: true } });
		expect(snapshot.diagnostics).toContainEqual({
			code: "read-error",
			message: "Could not read config file",
			path: unreadablePath,
			scope: "global",
		});
	});

	test("does not resurrect lower object fields after a scalar replacement", async () => {
		const replacingPath = `${HOME_ROOT}/.wincode/settings.json`;
		const highestPath = `${WORKSPACE}/.wincode/settings.json`;
		const store = createConfigStore({
			fs: fileSystem({
				[replacingPath]: '{"profile":{"shared":null}}',
				[highestPath]: '{"profile":{"shared":{"enabled":false}}}',
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({
			profile: { shared: { enabled: false } },
		});
		expect(snapshot.sourceFor(["profile", "shared", "enabled"])).toEqual({
			path: highestPath,
			scope: "project",
		});
		expect(snapshot.sourceFor(["profile", "shared", "removed"])).toEqual({
			path: highestPath,
			scope: "project",
		});
	});

	test("memoizes one snapshot per resolved workspace", async () => {
		const reads: string[] = [];
		const store = createConfigStore({
			fs: fileSystem(
				{
					[`${WORKSPACE}/.wincode/settings.json`]:
						'{"settings":{"cached":true}}',
				},
				reads
			),
			homeRoot: HOME_ROOT,
		});

		const firstRequest = store.getSnapshot(WORKSPACE);
		const secondRequest = store.getSnapshot(`${WORKSPACE}/.`);
		const first = await firstRequest;
		const readCount = reads.length;
		const second = await secondRequest;

		expect(secondRequest).toBe(firstRequest);
		expect(second).toBe(first);
		expect(reads).toHaveLength(readCount);
	});

	test("refreshes a memoized workspace snapshot on demand", async () => {
		const configPath = `${WORKSPACE}/.wincode/settings.json`;
		const files = {
			[configPath]: '{"settings":{"version":1}}',
		};
		const store = createConfigStore({
			fs: fileSystem(files),
			homeRoot: HOME_ROOT,
		});
		const first = await store.getSnapshot(WORKSPACE);
		files[configPath] = '{"settings":{"version":2}}';

		const cached = await store.getSnapshot(WORKSPACE);
		const refreshed = await store.refreshSnapshot(WORKSPACE);

		expect(cached).toBe(first);
		expect(refreshed.document).toMatchObject({ settings: { version: 2 } });
		expect(await store.getSnapshot(WORKSPACE)).toBe(refreshed);
	});

	test("returns an immutable snapshot that can be shared across capabilities", async () => {
		const store = createConfigStore({
			fs: fileSystem({
				[`${WORKSPACE}/.wincode/settings.json`]:
					'{"settings":{"nested":{"enabled":true}}}',
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);
		const settings = snapshot.document.settings as Record<string, unknown>;

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.document)).toBe(true);
		expect(Object.isFrozen(settings.nested)).toBe(true);
		expect(Object.isFrozen(snapshot.sources)).toBe(true);
		expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
	});

	test("loads JSON and JSONC documents from the real filesystem", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-config-"));
		const homeRoot = path.join(root, "home");
		const xdgConfigHome = path.join(root, "xdg");
		const configRoot = path.join(xdgConfigHome, "wincode");
		const workspace = path.join(root, "workspace");
		const projectConfigRoot = path.join(workspace, ".wincode");
		const projectJsonPath = path.join(projectConfigRoot, "settings.json");
		const projectJsoncPath = path.join(projectConfigRoot, "settings.jsonc");

		try {
			await Promise.all([
				fs.mkdir(configRoot, { recursive: true }),
				fs.mkdir(path.join(homeRoot, ".wincode"), { recursive: true }),
				fs.mkdir(projectConfigRoot, { recursive: true }),
			]);
			await Promise.all([
				Bun.write(
					path.join(configRoot, "wincode.json"),
					JSON.stringify({
						settings: { layers: { xdg: true }, selected: "xdg" },
					})
				),
				Bun.write(
					path.join(homeRoot, ".wincode", "settings.json"),
					JSON.stringify({ settings: { layers: { home: true } } })
				),
				Bun.write(
					path.join(workspace, "wincode.json"),
					JSON.stringify({ settings: { layers: { workspace: true } } })
				),
				Bun.write(
					projectJsonPath,
					JSON.stringify({
						settings: { layers: { ignoredJson: true }, selected: "json" },
					})
				),
				Bun.write(
					projectJsoncPath,
					'// JSONC wins\n{"settings":{"layers":{"project":true},"selected":"jsonc",},}'
				),
			]);

			const store = createConfigStore({
				homeRoot,
				trustedProjectRoots: [workspace],
			});
			const snapshot = await store.getSnapshot(workspace);

			expect(snapshot.document).toEqual({
				settings: {
					layers: { home: true, project: true },
					selected: "jsonc",
				},
			});
			expect(snapshot.diagnostics).toContainEqual({
				code: "duplicate-config",
				message: `Ignored duplicate config ${projectJsonPath}`,
				path: projectJsoncPath,
				scope: "project",
			});
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("writes a project value into the existing JSONC source and refreshes it", async () => {
		const projectPath = `${WORKSPACE}/.wincode/settings.jsonc`;
		const files: Record<string, string> = {
			[projectPath]: `{
	// Keep this comment.
	"compaction": { "auto": false },
	"agents": { "build": { "description": "Keep this setting." } }
}`,
		};
		const writes: Array<{ path: string; contents: string }> = [];
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					writes.push({ contents, path: file });
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.setValue(
			WORKSPACE,
			"project",
			["compaction", "auto"],
			true
		);

		expect(writes).toHaveLength(1);
		expect(writes[0]?.path).toBe(projectPath);
		expect(writes[0]?.contents).toContain("// Keep this comment.");
		expect(writes[0]?.contents).toContain(
			'"description": "Keep this setting."'
		);
		expect(snapshot.document).toMatchObject({
			compaction: { auto: true },
		});
	});

	test("writes a global value to the canonical global config source", async () => {
		const files: Record<string, string> = {};
		const writes: Array<{ path: string; contents: string }> = [];
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					writes.push({ contents, path: file });
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		await store.setValue(WORKSPACE, "global", ["compaction", "auto"], false);

		expect(writes).toEqual([
			{
				contents: '{\n  "compaction": {\n    "auto": false\n  }\n}\n',
				path: `${HOME_ROOT}/.wincode/settings.json`,
			},
		]);
	});

	test("removes a persisted value when set to undefined", async () => {
		const projectPath = `${WORKSPACE}/.wincode/settings.json`;
		const files: Record<string, string> = {
			[projectPath]: '{"compaction":{"auto":false,"reserveTokens":1000}}',
		};
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.setValue(
			WORKSPACE,
			"project",
			["compaction", "auto"],
			undefined
		);

		expect(snapshot.document).toEqual({
			compaction: { reserveTokens: 1000 },
		});
	});
	test("serializes concurrent writes to preserve the latest value", async () => {
		const projectPath = `${WORKSPACE}/.wincode/settings.json`;
		const files: Record<string, string> = {
			[projectPath]: '{"compaction":{"auto":false}}',
		};
		const writes: string[] = [];
		let writeCount = 0;
		let resolveFirstWriteStarted: (() => void) | undefined;
		let releaseFirstWrite: (() => void) | undefined;
		const firstWriteStarted = new Promise<void>((resolve) => {
			resolveFirstWriteStarted = resolve;
		});
		const firstWriteReleased = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					writeCount += 1;
					if (writeCount === 1) {
						resolveFirstWriteStarted?.();
						await firstWriteReleased;
					}
					writes.push(contents);
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		const first = store.setValue(
			WORKSPACE,
			"project",
			["compaction", "auto"],
			true
		);
		await firstWriteStarted;
		const second = store.setValue(
			WORKSPACE,
			"project",
			["compaction", "auto"],
			false
		);
		releaseFirstWrite?.();
		await Promise.all([first, second]);

		expect(writes).toHaveLength(2);
		expect(JSON.parse(files[projectPath] ?? "{}")).toEqual({
			compaction: { auto: false },
		});
	});
	test("queues a reset behind a pending write for a new setting", async () => {
		const projectPath = `${WORKSPACE}/.wincode/settings.json`;
		const files: Record<string, string> = {};
		let resolveFirstWriteStarted: (() => void) | undefined;
		let releaseFirstWrite: (() => void) | undefined;
		const firstWriteStarted = new Promise<void>((resolve) => {
			resolveFirstWriteStarted = resolve;
		});
		const firstWriteReleased = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		let writeCount = 0;
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					writeCount += 1;
					if (writeCount === 1) {
						resolveFirstWriteStarted?.();
						await firstWriteReleased;
					}
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		const first = store.setValue(
			WORKSPACE,
			"project",
			["compaction", "auto"],
			false
		);
		await firstWriteStarted;
		const reset = store.setValue(
			WORKSPACE,
			"project",
			["compaction", "auto"],
			undefined
		);
		releaseFirstWrite?.();
		await Promise.all([first, reset]);

		expect(JSON.parse(files[projectPath] ?? "{}")).toEqual({
			compaction: {},
		});
	});
	test("uses canonical targets when a scoped parent exists elsewhere", async () => {
		const files: Record<string, string> = {
			[`${HOME_ROOT}/.wincode/settings.json`]:
				'{"compaction":{"keepRecentTokens":1000}}',
			[`${WORKSPACE}/.wincode/settings.json`]:
				'{"compaction":{"keepRecentTokens":2000}}',
		};
		const writes: string[] = [];
		const store = createConfigStore({
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					writes.push(file);
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});

		await store.setValue(WORKSPACE, "global", ["compaction", "auto"], false);
		await store.setValue(WORKSPACE, "project", ["compaction", "auto"], true);

		expect(writes).toEqual([
			`${HOME_ROOT}/.wincode/settings.json`,
			`${WORKSPACE}/.wincode/settings.json`,
		]);
	});
	test("rejects writes for a read-only injected filesystem", async () => {
		const store = createConfigStore({
			fs: fileSystem({
				[`${WORKSPACE}/.wincode/settings.json`]: "{}",
			}),
			homeRoot: HOME_ROOT,
		});

		await expect(
			store.setValue(WORKSPACE, "project", ["compaction", "auto"], true)
		).rejects.toThrow("Config persistence is unavailable.");
	});
});
