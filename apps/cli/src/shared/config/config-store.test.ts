import { describe, expect, test } from "bun:test";
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
});
