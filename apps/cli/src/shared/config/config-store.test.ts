import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "./config-store";

const CONFIG_ROOT = "/home/user/.config/wincode";
const HOME_ROOT = "/home/user";
const WORKSPACE = "/workspace";

const fileSystem = (files: Record<string, string>, reads?: string[]) => ({
	readFile: async (file: string): Promise<string> => {
		reads?.push(file);
		const value = files[file];
		if (value === undefined) {
			const error = new Error("missing") as Error & { code: string };
			error.code = "ENOENT";
			throw error;
		}
		return value;
	},
});

describe("createConfigStore", () => {
	test("loads and recursively merges the ordered Wincode config sources", async () => {
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: fileSystem({
				[`${CONFIG_ROOT}/wincode.json`]: JSON.stringify({
					settings: {
						profile: {
							metadata: { global: true, shared: "global" },
							tags: ["global"],
						},
					},
				}),
				[`${HOME_ROOT}/.wincode/wincode.json`]: JSON.stringify({
					settings: { profile: { metadata: { home: true } } },
				}),
				[`${WORKSPACE}/wincode.json`]: JSON.stringify({
					settings: {
						profile: {
							metadata: { shared: "workspace" },
							tags: ["workspace"],
						},
					},
				}),
				[`${WORKSPACE}/.wincode/wincode.json`]: JSON.stringify({
					settings: { profile: { enabled: false } },
				}),
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({
			settings: {
				profile: {
					enabled: false,
					metadata: {
						global: true,
						home: true,
						shared: "workspace",
					},
					tags: ["workspace"],
				},
			},
		});
		expect(
			snapshot.sourceFor(["settings", "profile", "metadata", "global"])
		).toEqual({
			path: `${CONFIG_ROOT}/wincode.json`,
			scope: "global",
		});
		expect(
			snapshot.sourceFor(["settings", "profile", "metadata", "shared"])
		).toEqual({
			path: `${WORKSPACE}/wincode.json`,
			scope: "project",
		});
		expect(snapshot.sourceFor(["settings", "profile", "enabled"])).toEqual({
			path: `${WORKSPACE}/.wincode/wincode.json`,
			scope: "project",
		});
		expect(
			snapshot.sources.map(({ path, scope }) => ({ path, scope }))
		).toEqual([
			{ path: `${CONFIG_ROOT}/wincode.json`, scope: "global" },
			{ path: `${HOME_ROOT}/.wincode/wincode.json`, scope: "global" },
			{ path: `${WORKSPACE}/wincode.json`, scope: "project" },
			{ path: `${WORKSPACE}/.wincode/wincode.json`, scope: "project" },
		]);
	});

	test("prefers JSONC and reports a duplicate JSON document", async () => {
		const jsonPath = `${WORKSPACE}/wincode.json`;
		const jsoncPath = `${WORKSPACE}/wincode.jsonc`;
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
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
		const malformedPath = `${CONFIG_ROOT}/wincode.json`;
		const unsafePath = `${HOME_ROOT}/.wincode/wincode.json`;
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: fileSystem({
				[malformedPath]: '{"settings":',
				[unsafePath]: '{"constructor":{}}',
				[`${WORKSPACE}/wincode.json`]: '{"settings":{"valid":true}}',
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({ settings: { valid: true } });
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
					scope: "global",
				},
			])
		);
	});

	test("isolates unreadable config sources with a diagnostic", async () => {
		const unreadablePath = `${CONFIG_ROOT}/wincode.jsonc`;
		const files = {
			[`${WORKSPACE}/wincode.json`]: '{"settings":{"valid":true}}',
		};
		const fallback = fileSystem(files);
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
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
		const replacingPath = `${HOME_ROOT}/.wincode/wincode.json`;
		const highestPath = `${WORKSPACE}/wincode.json`;
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: fileSystem({
				[`${CONFIG_ROOT}/wincode.json`]: JSON.stringify({
					mcp: {
						shared: { type: "remote", url: "https://global.example" },
					},
				}),
				[replacingPath]: '{"mcp":{"shared":null}}',
				[highestPath]: '{"mcp":{"shared":{"permission":"allow"}}}',
			}),
			homeRoot: HOME_ROOT,
		});

		const snapshot = await store.getSnapshot(WORKSPACE);

		expect(snapshot.document).toEqual({
			mcp: { shared: { permission: "allow" } },
		});
		expect(snapshot.sourceFor(["mcp", "shared", "permission"])).toEqual({
			path: highestPath,
			scope: "project",
		});
		expect(snapshot.sourceFor(["mcp", "shared", "url"])).toEqual({
			path: highestPath,
			scope: "project",
		});
	});

	test("memoizes one snapshot per resolved workspace", async () => {
		const reads: string[] = [];
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: fileSystem(
				{
					[`${WORKSPACE}/wincode.json`]: '{"settings":{"cached":true}}',
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
		const configPath = `${WORKSPACE}/wincode.json`;
		const files = {
			[configPath]: '{"settings":{"version":1}}',
		};
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
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
			configRoot: CONFIG_ROOT,
			fs: fileSystem({
				[`${WORKSPACE}/wincode.json`]:
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
		const root = await mkdtemp(join(tmpdir(), "wincode-config-"));
		const homeRoot = join(root, "home");
		const xdgConfigHome = join(root, "xdg");
		const configRoot = join(xdgConfigHome, "wincode");
		const workspace = join(root, "workspace");
		const projectConfigRoot = join(workspace, ".wincode");
		const projectJsonPath = join(projectConfigRoot, "wincode.json");
		const projectJsoncPath = join(projectConfigRoot, "wincode.jsonc");

		try {
			await Promise.all([
				mkdir(configRoot, { recursive: true }),
				mkdir(join(homeRoot, ".wincode"), { recursive: true }),
				mkdir(projectConfigRoot, { recursive: true }),
			]);
			await Promise.all([
				writeFile(
					join(configRoot, "wincode.json"),
					JSON.stringify({
						settings: { layers: { xdg: true }, selected: "xdg" },
					})
				),
				writeFile(
					join(homeRoot, ".wincode", "wincode.json"),
					JSON.stringify({ settings: { layers: { home: true } } })
				),
				writeFile(
					join(workspace, "wincode.json"),
					JSON.stringify({ settings: { layers: { workspace: true } } })
				),
				writeFile(
					projectJsonPath,
					JSON.stringify({
						settings: { layers: { ignoredJson: true }, selected: "json" },
					})
				),
				writeFile(
					projectJsoncPath,
					'// JSONC wins\n{"settings":{"layers":{"project":true},"selected":"jsonc",},}'
				),
			]);

			const store = createConfigStore({ homeRoot, xdgConfigHome });
			const snapshot = await store.getSnapshot(workspace);

			expect(snapshot.document).toEqual({
				settings: {
					layers: {
						home: true,
						project: true,
						workspace: true,
						xdg: true,
					},
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
			await rm(root, { force: true, recursive: true });
		}
	});

	test("writes a project value into the existing JSONC source and refreshes it", async () => {
		const projectPath = `${WORKSPACE}/.wincode/wincode.jsonc`;
		const files: Record<string, string> = {
			[projectPath]: `{
	// Keep this comment.
	"compaction": { "auto": false },
	"agents": { "build": { "description": "Keep this setting." } }
}`,
		};
		const writes: Array<{ path: string; contents: string }> = [];
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
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
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
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
				path: `${CONFIG_ROOT}/wincode.json`,
			},
		]);
	});

	test("removes a persisted value when set to undefined", async () => {
		const projectPath = `${WORKSPACE}/wincode.json`;
		const files: Record<string, string> = {
			[projectPath]: '{"compaction":{"auto":false,"reserveTokens":1000}}',
		};
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
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
		const projectPath = `${WORKSPACE}/wincode.json`;
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
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
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
		const projectPath = `${WORKSPACE}/.wincode/wincode.json`;
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
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
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
			[`${HOME_ROOT}/.wincode/wincode.json`]:
				'{"compaction":{"keepRecentTokens":1000}}',
			[`${WORKSPACE}/wincode.json`]: '{"compaction":{"keepRecentTokens":2000}}',
		};
		const writes: string[] = [];
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
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
			`${CONFIG_ROOT}/wincode.json`,
			`${WORKSPACE}/.wincode/wincode.json`,
		]);
	});
	test("rejects writes for a read-only injected filesystem", async () => {
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: fileSystem({
				[`${WORKSPACE}/wincode.json`]: "{}",
			}),
			homeRoot: HOME_ROOT,
		});

		await expect(
			store.setValue(WORKSPACE, "project", ["compaction", "auto"], true)
		).rejects.toThrow("Config persistence is unavailable.");
	});
});
