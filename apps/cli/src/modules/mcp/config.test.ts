import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMcpConfig } from "./config";

const fileSystem = (files: Record<string, string>) => ({
	readFile: async (path: string) => {
		const value = files[path];
		if (value === undefined) {
			const error = new Error("missing") as Error & { code: string };
			error.code = "ENOENT";
			throw error;
		}
		return value;
	},
});

describe("loadMcpConfig", () => {
	const withRoots = async (
		files: {
			global?: Record<string, string>;
			project?: Record<string, string>;
		},
		fn: (globalRoot: string, projectRoot: string) => Promise<void>
	) => {
		const root = await mkdtemp(path.join(os.tmpdir(), "mcp-config-"));
		const globalRoot = path.join(root, "global");
		const projectRoot = path.join(root, "project");
		await Promise.all([
			mkdir(globalRoot, { recursive: true }),
			mkdir(projectRoot, { recursive: true }),
		]);
		for (const [scope, values] of Object.entries(files)) {
			const target = scope === "global" ? globalRoot : projectRoot;
			for (const [name, contents] of Object.entries(values ?? {})) {
				// biome-ignore lint/correctness/noUndeclaredVariables: Bun runtime API
				await Bun.write(path.join(target, name), contents);
			}
		}
		try {
			await fn(globalRoot, projectRoot);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};

	test("prefers jsonc and warns about duplicate json", async () => {
		await withRoots(
			{
				project: {
					"opencode.jsonc":
						'{"mcp":{"servers":{"x":{"type":"remote","url":"https://x"}}}}',
					"opencode.json": "{}",
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.x).toMatchObject({ url: "https://x/" });
				expect(
					result.diagnostics.some((d) => d.code === "duplicate-config")
				).toBe(true);
			}
		);
	});
	test("loads JSON only without duplicate warning and accepts comments/trailing commas", async () => {
		await withRoots(
			{
				project: {
					"opencode.json":
						'{// comment\n"mcp":{"servers":{"x":{"type":"remote","url":"https://x",},},},}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.x).toBeDefined();
				expect(
					result.diagnostics.some((d) => d.code === "duplicate-config")
				).toBe(false);
			}
		);
	});
	test("exports true timeout defaults", async () => {
		await withRoots(
			{
				project: {
					"opencode.json":
						'{"mcp":{"servers":{"x":{"type":"remote","url":"https://x"}}}}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.x?.timeout).toEqual({
					startup: 30_000,
					catalog: 30_000,
					execution: 43_200_000,
				});
			}
		);
	});
	test("merges partial global, project, and server phases", async () => {
		await withRoots(
			{
				global: {
					"opencode.json":
						'{"mcp":{"timeout":{"startup":1,"catalog":2},"servers":{"x":{"type":"remote","url":"https://x","timeout":{"execution":3}}}}}',
				},
				project: {
					"opencode.json":
						'{"mcp":{"timeout":{"catalog":4},"servers":{"x":{"headers":{"a":"b"}}}}}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.x?.timeout).toEqual({
					startup: 1,
					catalog: 4,
					execution: 3,
				});
			}
		);
	});
	test("reports every invalid timeout phase", async () => {
		for (const [phase, value] of Object.entries({
			startup: 0,
			catalog: 1.5,
			execution: "x",
		})) {
			await withRoots(
				{
					project: {
						"opencode.json": JSON.stringify({
							mcp: { timeout: { [phase]: value } },
						}),
					},
				},
				async (globalRoot, workspace) => {
					const result = await loadMcpConfig({
						globalRoot,
						workspace,
						env: {},
					});
					expect(
						result.diagnostics.some(
							(d) => d.code === "invalid-timeout" && d.path.endsWith(phase)
						)
					).toBe(true);
				}
			);
		}
	});
	test("ignores codemode and unrelated fields while validating supported fields", async () => {
		await withRoots(
			{
				project: {
					"opencode.json":
						'{"mcp":{"servers":{"x":{"type":"remote","url":"https://x","codemode":true,"unrelated":1}}}}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.x).toBeDefined();
			}
		);
	});
	test("isolates invalid mcp and servers scopes", async () => {
		await withRoots(
			{
				global: { "opencode.json": '{"mcp":[]}' },
				project: {
					"opencode.json": '{"mcp":{"servers":[],"timeout":{"startup":1}}}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(
					result.diagnostics.filter((d) => d.code === "invalid-scope")
				).toHaveLength(2);
			}
		);
	});
	test("reports missing env variable and server without secret", async () => {
		await withRoots(
			{
				project: {
					"opencode.json":
						'{"mcp":{"servers":{"named":{"type":"remote","url":"https://x","headers":{"authorization":"{env:SECRET}"}}}}}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				const diagnostic = result.diagnostics.find(
					(d) => d.code === "missing-env"
				);
				expect(diagnostic?.message).toContain("SECRET");
				expect(diagnostic?.message).toContain("named");
				expect(JSON.stringify(diagnostic)).not.toContain("{env:SECRET}");
			}
		);
	});
	test("accepts placeholder only and isolates invalid URLs/oauth", async () => {
		await withRoots(
			{
				project: {
					"opencode.json":
						'{"mcp":{"servers":{"good":{"type":"remote","url":"https://x"},"bad":{"type":"remote","url":"ftp://x"},"oauth":{"type":"remote","url":"https://y","oauth":{}}}}}',
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.good).toBeDefined();
				expect(result.servers.bad).toBeUndefined();
				expect(result.servers.oauth).toBeUndefined();
			}
		);
	});
	test("supports POSIX and Windows absolute cwd", async () => {
		await withRoots(
			{
				project: {
					"opencode.json": JSON.stringify({
						mcp: {
							servers: {
								posix: { type: "local", command: ["x"], cwd: "/tmp" },
								windows: { type: "local", command: ["x"], cwd: "C:\\tools" },
							},
						},
					}),
				},
			},
			async (globalRoot, workspace) => {
				const result = await loadMcpConfig({ globalRoot, workspace, env: {} });
				expect(result.servers.posix).toMatchObject({ cwd: "/tmp" });
				expect(result.servers.windows).toMatchObject({ cwd: "C:\\tools" });
			}
		);
	});
	test("loads JSONC, merges scopes, resolves values, and applies defaults", async () => {
		const result = await loadMcpConfig({
			workspace: "/project",
			globalRoot: "/home/user",
			env: { TOKEN: "secret" },
			fs: fileSystem({
				"/home/user/opencode.jsonc": `// global\n{"mcp":{"timeout":{"startup":5000,"catalog":5000,"execution":5000},"servers":{"one":{"type":"local","command":["x"],"environment":{"TOKEN":"{env:TOKEN}"}},"remote":{"type":"remote","url":"https://example.com","headers":{"x":"g"}}}}}`,
				"/project/opencode.json": `{"mcp":{"servers":{"one":{"cwd":"tools","disabled":true},"remote":{"headers":{"y":"p"}}}}}`,
			}),
		});
		expect(result.servers).toEqual({
			one: {
				name: "one",
				type: "local",
				command: ["x"],
				cwd: "/project/tools",
				environment: { TOKEN: "secret" },
				disabled: true,
				timeout: { startup: 5000, catalog: 5000, execution: 5000 },
			},
			remote: {
				name: "remote",
				type: "remote",
				url: "https://example.com/",
				headers: { x: "g", y: "p" },
				disabled: false,
				timeout: { startup: 5000, catalog: 5000, execution: 5000 },
			},
		});
	});

	test("isolates invalid servers and sanitizes missing env diagnostics", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json": `{"mcp":{"servers":{"bad":{"type":"remote","url":"ftp://x"},"missing":{"type":"remote","url":"https://x","headers":{"authorization":"{env:SECRET}"}},"ok":{"type":"remote","url":"https://ok","oauth":false}}}}`,
			}),
		});
		expect(Object.keys(result.servers)).toEqual(["ok"]);
		expect(
			result.diagnostics.some((diagnostic) => diagnostic.code === "missing-env")
		).toBe(true);
		expect(
			result.diagnostics.some((diagnostic) =>
				diagnostic.message.includes("ftp://x")
			)
		).toBe(false);
	});

	test("isolates servers with missing or unsupported types", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"missing":{"url":"https://missing"},"unsupported":{"type":"custom","url":"https://unsupported"},"valid":{"type":"remote","url":"https://valid"}}}}',
			}),
		});

		expect(Object.keys(result.servers)).toEqual(["valid"]);
		const typeDiagnostics = result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "invalid-server"
		);
		expect(typeDiagnostics).toHaveLength(2);
		expect(typeDiagnostics.map((diagnostic) => diagnostic.serverName)).toEqual([
			"missing",
			"unsupported",
		]);
		expect(typeDiagnostics.map((diagnostic) => diagnostic.path)).toEqual([
			"/p/opencode.json:mcp.servers.missing.type",
			"/p/opencode.json:mcp.servers.unsupported.type",
		]);
	});

	test("project malformed entry omits inherited server and reports project scope", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/g/opencode.json":
					'{"mcp":{"servers":{"shared":{"type":"remote","url":"https://global"}}}}',
				"/p/opencode.json": '{"mcp":{"servers":{"shared":null}}}',
			}),
		});

		expect(result.servers.shared).toBeUndefined();
		expect(result.diagnostics).toContainEqual({
			scope: "project",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: "/p/opencode.json:mcp.servers.shared",
			serverName: "shared",
		});
	});

	test("isolates project-only scalar server entries", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json": '{"mcp":{"servers":{"scalar":"invalid"}}}',
			}),
		});

		expect(result.servers.scalar).toBeUndefined();
		expect(result.diagnostics).toContainEqual({
			scope: "project",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: "/p/opencode.json:mcp.servers.scalar",
			serverName: "scalar",
		});
	});

	test("valid project entry recovers malformed global entry", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/g/opencode.json": '{"mcp":{"servers":{"shared":null}}}',
				"/p/opencode.json":
					'{"mcp":{"servers":{"shared":{"type":"remote","url":"https://project"}}}}',
			}),
		});

		expect(result.servers.shared).toMatchObject({
			type: "remote",
			url: "https://project/",
		});
		expect(result.diagnostics).toContainEqual({
			scope: "global",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: "/g/opencode.json:mcp.servers.shared",
			serverName: "shared",
		});
	});
	test("rejects unsafe prototype keys", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({ "/p/opencode.json": '{"__proto__":{},"mcp":{}}' }),
		});
		expect(result.diagnostics.some((d) => d.code === "unsafe-key")).toBe(true);
	});
	test("rejects invalid local command", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"x":{"type":"local","command":[]}}}}',
			}),
		});
		expect(result.servers.x).toBeUndefined();
	});
	test("resolves environment placeholders", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: { A: "b" },
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"x":{"type":"local","command":["x"],"environment":{"a":"{env:A}"}}}}}',
			}),
		});
		expect(
			result.servers.x?.type === "local" && result.servers.x.environment
		).toEqual({ a: "b" });
	});
	test("keeps literal braces", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"x":{"type":"local","command":["x"],"environment":{"a":"literal"}}}}}',
			}),
		});
		expect(
			result.servers.x?.type === "local" && result.servers.x.environment
		).toEqual({ a: "literal" });
	});
	test("rejects non-string headers", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"x":{"type":"remote","url":"https://x","headers":{"a":1}}}}}',
			}),
		});
		expect(result.servers.x).toBeUndefined();
	});
	test("accepts oauth false", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"x":{"type":"remote","url":"https://x","oauth":false}}}}',
			}),
		});
		expect(result.servers.x?.type === "remote" && result.servers.x.oauth).toBe(
			false
		);
	});
	test("normalizes remote URLs", async () => {
		const result = await loadMcpConfig({
			workspace: "/p",
			globalRoot: "/g",
			env: {},
			fs: fileSystem({
				"/p/opencode.json":
					'{"mcp":{"servers":{"x":{"type":"remote","url":"https://x/path"}}}}',
			}),
		});
		expect(result.servers.x?.type === "remote" && result.servers.x.url).toBe(
			"https://x/path"
		);
	});
});
