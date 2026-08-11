import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig } from "./config";

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

type LoadOptions = {
	configRoot?: string;
	env?: Record<string, string | undefined>;
	homeRoot?: string;
	reads?: string[];
	workspace?: string;
};

const load = (
	files: Record<string, string>,
	options: LoadOptions = {}
): ReturnType<typeof loadMcpConfig> =>
	loadMcpConfig({
		configRoot: options.configRoot ?? CONFIG_ROOT,
		env: options.env ?? {},
		fs: fileSystem(files, options.reads),
		homeRoot: options.homeRoot ?? HOME_ROOT,
		workspace: options.workspace ?? WORKSPACE,
	});

describe("loadMcpConfig", () => {
	test("loads project MCP config from the Git root for a nested workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-mcp-config-"));
		const workspace = join(root, "apps", "cli");
		try {
			await Promise.all([
				mkdir(join(root, ".git")),
				mkdir(workspace, { recursive: true }),
			]);
			await writeFile(
				join(root, "wincode.json"),
				JSON.stringify({
					mcp: {
						context7: { type: "local", command: ["context7"] },
					},
				})
			);

			const result = await loadMcpConfig({
				configRoot: join(root, "config"),
				env: {},
				homeRoot: join(root, "home"),
				workspace,
			});

			expect(Object.keys(result.servers)).toEqual(["context7"]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("loads and merges every Wincode config layer in precedence order", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]: JSON.stringify({
				mcp: {
					shared: {
						type: "remote",
						url: "https://global.example/mcp",
						headers: { xdg: "yes" },
					},
				},
			}),
			[`${HOME_ROOT}/.wincode/wincode.json`]: JSON.stringify({
				mcp: { shared: { headers: { home: "yes" } } },
			}),
			[`${WORKSPACE}/wincode.json`]: JSON.stringify({
				mcp: { shared: { permission: "allow" } },
			}),
			[`${WORKSPACE}/.wincode/wincode.json`]: JSON.stringify({
				mcp: {
					shared: {
						url: "https://project.example/mcp",
						headers: { project: "yes" },
					},
				},
			}),
		});

		expect(result.servers.shared).toMatchObject({
			disabled: false,
			headers: { xdg: "yes", home: "yes", project: "yes" },
			permission: "allow",
			url: "https://project.example/mcp",
		});
	});

	test("reads flat MCP entries and resolves enabled and permission defaults", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]: JSON.stringify({
				mcp: {
					disabled: {
						type: "local",
						command: ["disabled"],
						enabled: false,
						permission: "deny",
					},
					enabled: {
						type: "local",
						command: ["enabled"],
					},
				},
			}),
		});

		expect(result.servers.disabled).toMatchObject({
			disabled: true,
			permission: "deny",
		});
		expect(result.servers.enabled).toMatchObject({
			disabled: false,
			permission: "ask",
		});
	});

	test("prefers JSONC and warns about duplicate JSON at one location", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.jsonc`]:
				'{"mcp":{"x":{"type":"remote","url":"https://x"}}}',
			[`${WORKSPACE}/wincode.json`]: "{}",
		});

		expect(result.servers.x).toMatchObject({ url: "https://x/" });
		expect(
			result.diagnostics.some(
				(diagnostic) => diagnostic.code === "duplicate-config"
			)
		).toBe(true);
	});

	test("accepts comments and trailing commas in JSON files", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{// comment\n"mcp":{"x":{"type":"remote","url":"https://x",},},}',
		});

		expect(result.servers.x).toBeDefined();
		expect(
			result.diagnostics.some(
				(diagnostic) => diagnostic.code === "duplicate-config"
			)
		).toBe(false);
	});

	test("applies timeout defaults and merges per-server phases", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]: JSON.stringify({
				mcp: {
					x: {
						type: "remote",
						url: "https://x",
						timeout: { startup: 1, execution: 3 },
					},
					y: { type: "remote", url: "https://y" },
				},
			}),
			[`${WORKSPACE}/wincode.json`]: JSON.stringify({
				mcp: { x: { timeout: { catalog: 4 } } },
			}),
		});

		expect(result.servers.x?.timeout).toEqual({
			startup: 1,
			catalog: 4,
			execution: 3,
		});
		expect(result.servers.y?.timeout).toEqual({
			startup: 30_000,
			catalog: 30_000,
			execution: 43_200_000,
		});
	});

	test("arrays replace nested values and preserve the overriding provenance", async () => {
		const cases = [
			{
				field: "headers",
				global: { headers: { global: "value" }, url: "https://x" },
			},
			{
				field: "environment",
				global: { environment: { GLOBAL: "value" }, command: ["x"] },
			},
			{
				field: "timeout",
				global: {
					timeout: { startup: 1, catalog: 2, execution: 3 },
					url: "https://x",
				},
			},
		] as const;

		for (const testCase of cases) {
			const result = await load({
				[`${CONFIG_ROOT}/wincode.json`]: JSON.stringify({
					mcp: { x: { type: "remote", ...testCase.global } },
				}),
				[`${WORKSPACE}/wincode.json`]: JSON.stringify({
					mcp: { x: { [testCase.field]: [] } },
				}),
			});

			expect(result.servers.x).toBeUndefined();
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					scope: "project",
					path: expect.stringContaining(`wincode.json:mcp.x.${testCase.field}`),
				})
			);
		}
	});

	test("reports every invalid timeout phase", async () => {
		for (const [phase, value] of Object.entries({
			startup: 0,
			catalog: 1.5,
			execution: "x",
		})) {
			const result = await load({
				[`${WORKSPACE}/wincode.json`]: JSON.stringify({
					mcp: {
						x: {
							type: "remote",
							url: "https://x",
							timeout: { [phase]: value },
						},
					},
				}),
			});

			expect(
				result.diagnostics.some(
					(diagnostic) =>
						diagnostic.code === "invalid-timeout" &&
						diagnostic.path.endsWith(phase)
				)
			).toBe(true);
		}
	});

	test("rejects unknown server fields so typos cannot enable a server", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"typo":{"type":"local","command":["x"],"enbled":false},"legacy":{"type":"local","command":["x"],"disabled":true}}}',
		});

		expect(result.servers.typo).toBeUndefined();
		expect(result.servers.legacy).toBeUndefined();
		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.code === "invalid-field"
			)
		).toHaveLength(2);
		expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(
			expect.arrayContaining([
				`${WORKSPACE}/wincode.json:mcp.typo.enbled`,
				`${WORKSPACE}/wincode.json:mcp.legacy.disabled`,
			])
		);
	});

	test("isolates invalid MCP scopes", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]: '{"mcp":[]}',
			[`${HOME_ROOT}/.wincode/wincode.json`]: '{"mcp":"invalid"}',
		});

		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.code === "invalid-scope"
			)
		).toHaveLength(2);
	});

	test("reports missing env variables without leaking placeholders", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"named":{"type":"remote","url":"https://x","headers":{"authorization":"{env:SECRET}"}}}}',
		});
		const diagnostic = result.diagnostics.find(
			(entry) => entry.code === "missing-env"
		);

		expect(diagnostic?.message).toContain("SECRET");
		expect(diagnostic?.message).toContain("named");
		expect(JSON.stringify(diagnostic)).not.toContain("{env:SECRET}");
		expect(result.servers.named).toBeUndefined();
	});

	test("attributes missing env diagnostics to the layer that supplied the value", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]:
				'{"mcp":{"x":{"type":"remote","url":"https://x","headers":{"authorization":"{env:GLOBAL_SECRET}"}}}}',
			[`${WORKSPACE}/.wincode/wincode.json`]:
				'{"mcp":{"x":{"headers":{"project":"yes"}}}}',
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "missing-env",
				path: `${CONFIG_ROOT}/wincode.json:mcp.x.headers.authorization`,
				scope: "global",
			})
		);
		expect(JSON.stringify(result.diagnostics)).not.toContain(
			"{env:GLOBAL_SECRET}"
		);
	});

	test("isolates invalid URLs and unsupported OAuth", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"good":{"type":"remote","url":"https://x"},"bad":{"type":"remote","url":"ftp://x"},"oauth":{"type":"remote","url":"https://y","oauth":{}}}}',
		});

		expect(result.servers.good).toBeDefined();
		expect(result.servers.bad).toBeUndefined();
		expect(result.servers.oauth).toBeUndefined();
		expect(JSON.stringify(result.diagnostics)).not.toContain("ftp://x");
	});

	test("supports POSIX and Windows absolute cwd", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]: JSON.stringify({
				mcp: {
					posix: { type: "local", command: ["x"], cwd: "/tmp" },
					windows: {
						type: "local",
						command: ["x"],
						cwd: "C:\\tools",
					},
				},
			}),
		});

		expect(result.servers.posix).toMatchObject({ cwd: "/tmp" });
		expect(result.servers.windows).toMatchObject({ cwd: "C:\\tools" });
	});

	test("merges sources, resolves values, and applies status defaults", async () => {
		const result = await load(
			{
				[`${CONFIG_ROOT}/wincode.jsonc`]: `// global\n{"mcp":{"one":{"type":"local","command":["x"],"environment":{"TOKEN":"{env:TOKEN}"},"timeout":{"startup":5000,"catalog":5000,"execution":5000}},"remote":{"type":"remote","url":"https://example.com","headers":{"x":"g"}}}}`,
				[`${WORKSPACE}/wincode.json`]:
					'{"mcp":{"one":{"cwd":"tools","enabled":false,"permission":"deny"},"remote":{"headers":{"y":"p"}}}}',
			},
			{ env: { TOKEN: "secret" } }
		);

		expect(result.servers).toEqual({
			one: {
				name: "one",
				type: "local",
				command: ["x"],
				cwd: "/workspace/tools",
				environment: { TOKEN: "secret" },
				disabled: true,
				permission: "deny",
				timeout: { startup: 5000, catalog: 5000, execution: 5000 },
			},
			remote: {
				name: "remote",
				type: "remote",
				url: "https://example.com/",
				headers: { x: "g", y: "p" },
				disabled: false,
				permission: "ask",
				timeout: {
					startup: 30_000,
					catalog: 30_000,
					execution: 43_200_000,
				},
			},
		});
	});

	test("isolates servers with missing or unsupported types", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"missing":{"url":"https://missing"},"unsupported":{"type":"custom","url":"https://unsupported"},"valid":{"type":"remote","url":"https://valid"}}}',
		});

		expect(Object.keys(result.servers)).toEqual(["valid"]);
		const diagnostics = result.diagnostics.filter(
			(entry) => entry.code === "invalid-server"
		);
		expect(diagnostics.map((entry) => entry.serverName)).toEqual([
			"missing",
			"unsupported",
		]);
		expect(diagnostics.map((entry) => entry.path)).toEqual([
			`${WORKSPACE}/wincode.json:mcp.missing.type`,
			`${WORKSPACE}/wincode.json:mcp.unsupported.type`,
		]);
	});

	test("a malformed highest-precedence entry omits an inherited server", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]:
				'{"mcp":{"shared":{"type":"remote","url":"https://global"}}}',
			[`${WORKSPACE}/.wincode/wincode.json`]: '{"mcp":{"shared":null}}',
		});

		expect(result.servers.shared).toBeUndefined();
		expect(result.diagnostics).toContainEqual({
			scope: "project",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: `${WORKSPACE}/.wincode/wincode.json:mcp.shared`,
			serverName: "shared",
		});
	});

	test("does not resurrect fields below a malformed intermediate entry", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]:
				'{"mcp":{"shared":{"type":"remote","url":"https://global"}}}',
			[`${HOME_ROOT}/.wincode/wincode.json`]: '{"mcp":{"shared":null}}',
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"shared":{"permission":"allow"}}}',
		});

		expect(result.servers.shared).toBeUndefined();
		expect(result.diagnostics).toContainEqual({
			scope: "global",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: `${HOME_ROOT}/.wincode/wincode.json:mcp.shared`,
			serverName: "shared",
		});
	});

	test("isolates scalar server entries", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]: '{"mcp":{"scalar":"invalid"}}',
		});

		expect(result.servers.scalar).toBeUndefined();
		expect(result.diagnostics).toContainEqual({
			scope: "project",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: `${WORKSPACE}/wincode.json:mcp.scalar`,
			serverName: "scalar",
		});
	});

	test("a valid later entry recovers an earlier malformed entry", async () => {
		const result = await load({
			[`${CONFIG_ROOT}/wincode.json`]: '{"mcp":{"shared":null}}',
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"shared":{"type":"remote","url":"https://project"}}}',
		});

		expect(result.servers.shared).toMatchObject({
			type: "remote",
			url: "https://project/",
		});
		expect(result.diagnostics).toContainEqual({
			scope: "global",
			code: "invalid-server",
			message: "Server entry must be an object",
			path: `${CONFIG_ROOT}/wincode.json:mcp.shared`,
			serverName: "shared",
		});
	});

	test("rejects unsafe prototype keys", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]: '{"__proto__":{},"mcp":{}}',
		});

		expect(
			result.diagnostics.some((entry) => entry.code === "unsafe-key")
		).toBe(true);
	});

	test("rejects invalid local commands", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"x":{"type":"local","command":[]}}}',
		});

		expect(result.servers.x).toBeUndefined();
	});

	test("resolves environment placeholders and keeps literal values", async () => {
		const result = await load(
			{
				[`${WORKSPACE}/wincode.json`]:
					'{"mcp":{"x":{"type":"local","command":["x"],"environment":{"resolved":"{env:A}","literal":"value"}}}}',
			},
			{ env: { A: "b" } }
		);

		expect(
			result.servers.x?.type === "local" && result.servers.x.environment
		).toEqual({ resolved: "b", literal: "value" });
	});

	test("rejects non-string headers and invalid permissions", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"headers":{"type":"remote","url":"https://x","headers":{"a":1}},"permission":{"type":"remote","url":"https://x","permission":"always"}}}',
		});

		expect(result.servers.headers).toBeUndefined();
		expect(result.servers.permission).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-field",
				path: `${WORKSPACE}/wincode.json:mcp.permission.permission`,
			})
		);
	});

	test("accepts oauth false and normalizes remote URLs", async () => {
		const result = await load({
			[`${WORKSPACE}/wincode.json`]:
				'{"mcp":{"x":{"type":"remote","url":"https://x/path","oauth":false}}}',
		});

		expect(result.servers.x).toMatchObject({
			oauth: false,
			url: "https://x/path",
		});
	});

	test("uses XDG_CONFIG_HOME when no explicit config root is provided", async () => {
		const result = await loadMcpConfig({
			env: { XDG_CONFIG_HOME: "/xdg" },
			fs: fileSystem({
				"/xdg/wincode/wincode.json":
					'{"mcp":{"x":{"type":"remote","url":"https://x"}}}',
			}),
			homeRoot: HOME_ROOT,
			workspace: WORKSPACE,
		});

		expect(result.servers.x).toBeDefined();
	});

	test("never reads OpenCode config or the retired MCP policy file", async () => {
		const reads: string[] = [];
		await load({}, { reads });

		expect(reads.some((file) => file.includes("opencode"))).toBe(false);
		expect(reads.some((file) => file.endsWith("/mcp.json"))).toBe(false);
		expect(reads).toContain(`${HOME_ROOT}/.wincode/wincode.json`);
		expect(reads).toContain(`${WORKSPACE}/.wincode/wincode.json`);
	});
});
