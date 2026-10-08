import { expect, test } from "bun:test";
import * as path from "node:path";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpConfigOrigin,
	type McpConfigSnapshot,
	type McpConfigSource,
	resolveMcpConfig,
} from "@wincode/mcp";

const workspace = "/workspace";
const projectOrigin: McpConfigOrigin = {
	path: `${workspace}/wincode.jsonc`,
	scope: "project",
};
const userOrigin: McpConfigOrigin = {
	path: "/home/user/.config/wincode/wincode.jsonc",
	scope: "user",
};

type SnapshotOptions = Readonly<{
	sourceFor?: McpConfigSnapshot["sourceFor"];
	sources?: readonly McpConfigSource[];
}>;

const createSnapshot = (
	document: Readonly<Record<string, unknown>>,
	options: SnapshotOptions = {}
): McpConfigSnapshot => ({
	diagnostics: [],
	document,
	sourceFor: options.sourceFor ?? (() => projectOrigin),
	sources: options.sources ?? [{ ...projectOrigin, document }],
});

const resolve = (
	document: Readonly<Record<string, unknown>>,
	options: Readonly<{
		env?: Readonly<Record<string, string | undefined>>;
		snapshot?: SnapshotOptions;
	}> = {}
) =>
	resolveMcpConfig({
		env: options.env ?? {},
		snapshot: createSnapshot(document, options.snapshot),
		workspace,
	});

const resolveAsUser = (
	document: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>> = {}
) =>
	resolve(document, {
		env,
		snapshot: {
			sourceFor: () => userOrigin,
			sources: [{ ...userOrigin, document }],
		},
	});

test("valid local and remote servers resolve defaults, env, and phase timeouts", () => {
	const result = resolveAsUser(
		{
			mcp: {
				local: {
					command: ["bun", "run", "server.ts"],
					cwd: "servers",
					environment: { TOKEN: "{env:MCP_TOKEN}" },
					type: "local",
				},
				remote: {
					headers: { Authorization: "{env:MCP_TOKEN}" },
					timeout: { startup: 5000 },
					type: "remote",
					url: "https://mcp.example.test/tools?q=1",
				},
			},
		},
		{ MCP_TOKEN: "resolved-token" }
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.local).toEqual({
		command: ["bun", "run", "server.ts"],
		cwd: path.resolve(workspace, "servers"),
		disabled: false,
		environment: { TOKEN: "resolved-token" },
		name: "local",
		timeout: DEFAULT_MCP_TIMEOUTS,
		type: "local",
	});
	expect(result.servers.remote).toEqual({
		disabled: false,
		headers: { Authorization: "resolved-token" },
		name: "remote",
		timeout: { ...DEFAULT_MCP_TIMEOUTS, startup: 5000 },
		type: "remote",
		url: "https://mcp.example.test/tools?q=1",
	});
});

test("trusted project config can define local commands and remote endpoints", () => {
	const result = resolve(
		{
			mcp: {
				local: {
					command: ["bun", "run", "server.ts"],
					environment: { TOKEN: "{env:PROJECT_TOKEN}" },
					type: "local",
				},
				remote: {
					headers: { Authorization: "{env:PROJECT_TOKEN}" },
					type: "remote",
					url: "https://project.example.test/mcp",
				},
			},
		},
		{ env: { PROJECT_TOKEN: "project-secret" } }
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.local).toMatchObject({
		command: ["bun", "run", "server.ts"],
		environment: { TOKEN: "project-secret" },
		type: "local",
	});
	expect(result.servers.remote).toMatchObject({
		headers: { Authorization: "project-secret" },
		type: "remote",
		url: "https://project.example.test/mcp",
	});
});

test("trusted project local commands resolve with their configured enabled state", () => {
	const result = resolve({
		mcp: {
			active: {
				command: ["bun", "run", "server.ts"],
				type: "local",
			},
			disabled: {
				command: ["bun", "run", "server.ts"],
				enabled: false,
				type: "local",
			},
		},
	});

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.active).toMatchObject({
		command: ["bun", "run", "server.ts"],
		disabled: false,
		type: "local",
	});
	expect(result.servers.disabled).toMatchObject({
		disabled: true,
		type: "local",
	});
});

test("partial project headers are not merged with personal remote server credentials", () => {
	const result = resolve(
		{
			mcp: {
				remote: {
					headers: { Authorization: "{env:MCP_TOKEN}" },
					type: "remote",
					url: "https://trusted.example.test/mcp",
				},
			},
		},
		{
			env: { MCP_TOKEN: "private-token" },
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" &&
					field[1] === "remote" &&
					(field[2] === "type" || field[2] === "url")
						? userOrigin
						: projectOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								remote: {
									type: "remote",
									url: "https://trusted.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: {
							mcp: {
								remote: {
									headers: { Authorization: "{env:MCP_TOKEN}" },
								},
							},
						},
					},
				],
			},
		}
	);

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "invalid-server",
			path: `${projectOrigin.path}:mcp.remote.type`,
			scope: "project",
			serverName: "remote",
		})
	);
	expect(JSON.stringify(result)).not.toContain("private-token");
});

test("partial project authentication headers are rejected rather than borrowing a user endpoint", () => {
	const projectToken = "project-controlled-token";
	const result = resolve(
		{
			mcp: {
				remote: {
					headers: { Authorization: `Bearer ${projectToken}` },
					type: "remote",
					url: "https://trusted.example.test/mcp",
				},
			},
		},
		{
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" && field[1] === "remote" && field[2] === "headers"
						? projectOrigin
						: userOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								remote: {
									headers: { Authorization: "Bearer user-token" },
									type: "remote",
									url: "https://trusted.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: {
							mcp: {
								remote: {
									headers: { Authorization: `Bearer ${projectToken}` },
								},
							},
						},
					},
				],
			},
		}
	);

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "invalid-server",
			path: `${projectOrigin.path}:mcp.remote.type`,
			scope: "project",
			serverName: "remote",
		})
	);
	expect(JSON.stringify(result)).not.toContain(projectToken);
});

test("partial project Cookie headers are rejected rather than borrowing a user endpoint", () => {
	const projectCookie = "session=project-controlled";
	const result = resolve(
		{
			mcp: {
				remote: {
					headers: { Cookie: projectCookie },
					type: "remote",
					url: "https://trusted.example.test/mcp",
				},
			},
		},
		{
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" && field[1] === "remote" && field[2] === "headers"
						? projectOrigin
						: userOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								remote: {
									type: "remote",
									url: "https://trusted.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: {
							mcp: { remote: { headers: { Cookie: projectCookie } } },
						},
					},
				],
			},
		}
	);

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "invalid-server",
			path: `${projectOrigin.path}:mcp.remote.type`,
			scope: "project",
			serverName: "remote",
		})
	);
	expect(JSON.stringify(result)).not.toContain(projectCookie);
});

test("a partial project URL cannot be combined with user-configured headers", () => {
	const result = resolve(
		{
			mcp: {
				remote: {
					headers: { Authorization: "{env:MCP_TOKEN}" },
					type: "remote",
					url: "https://attacker.example.test/mcp",
				},
			},
		},
		{
			env: { MCP_TOKEN: "private-token" },
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" &&
					field[1] === "remote" &&
					(field[2] === "type" || field[2] === "headers")
						? userOrigin
						: projectOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								remote: {
									headers: { Authorization: "{env:MCP_TOKEN}" },
									type: "remote",
									url: "https://trusted.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: {
							mcp: {
								remote: {
									url: "https://attacker.example.test/mcp",
								},
							},
						},
					},
				],
			},
		}
	);

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "invalid-server",
			path: `${projectOrigin.path}:mcp.remote.type`,
			scope: "project",
			serverName: "remote",
		})
	);
});

test("project remote definitions and enabled-only overlays are supported", () => {
	const projectServer = resolve({
		mcp: {
			remote: {
				type: "remote",
				url: "https://attacker.example.test/mcp",
			},
		},
	});
	const reenabledServer = resolve(
		{
			mcp: {
				remote: {
					enabled: true,
					type: "remote",
					url: "https://trusted.example.test/mcp",
				},
			},
		},
		{
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" && field[1] === "remote" && field[2] !== "enabled"
						? userOrigin
						: projectOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								remote: {
									enabled: false,
									type: "remote",
									url: "https://trusted.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: { mcp: { remote: { enabled: true } } },
					},
				],
			},
		}
	);

	expect(projectServer.diagnostics).toEqual([]);
	expect(projectServer.servers.remote).toMatchObject({
		disabled: false,
		type: "remote",
		url: "https://attacker.example.test/mcp",
	});
	expect(reenabledServer.diagnostics).toEqual([]);
	expect(reenabledServer.servers.remote).toMatchObject({
		disabled: false,
		type: "remote",
		url: "https://trusted.example.test/mcp",
	});
});

test("a partial project timeout does not merge with personal local server details", () => {
	const userDocument = {
		mcp: { local: { command: ["bun", "run", "server.ts"], type: "local" } },
	};
	const projectDocument = {
		mcp: { local: { timeout: { startup: 5000 } } },
	};
	const result = resolve(
		{
			mcp: {
				local: {
					command: ["bun", "run", "server.ts"],
					timeout: { startup: 5000 },
					type: "local",
				},
			},
		},
		{
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" &&
					field[1] === "local" &&
					(field[2] === "command" || field[2] === "type")
						? userOrigin
						: projectOrigin,
				sources: [
					{ ...userOrigin, document: userDocument },
					{ ...projectOrigin, document: projectDocument },
				],
			},
		}
	);

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "invalid-server",
			path: `${projectOrigin.path}:mcp.local.type`,
			scope: "project",
			serverName: "local",
		})
	);
});

test("an enabled-only project overlay can re-enable a personal local server", () => {
	const result = resolve(
		{
			mcp: {
				local: {
					command: ["bun", "run", "server.ts"],
					enabled: true,
					type: "local",
				},
			},
		},
		{
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" &&
					field[1] === "local" &&
					(field[2] === "command" || field[2] === "type")
						? userOrigin
						: projectOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								local: {
									command: ["bun", "run", "server.ts"],
									enabled: false,
									type: "local",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: { mcp: { local: { enabled: true } } },
					},
				],
			},
		}
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.local).toMatchObject({
		command: ["bun", "run", "server.ts"],
		disabled: false,
		type: "local",
	});
});

test("relative, POSIX absolute, and Windows absolute working directories stay distinct", () => {
	const result = resolveAsUser({
		mcp: {
			posix: { command: ["server"], cwd: "/opt/mcp", type: "local" },
			relative: { command: ["server"], cwd: "../mcp", type: "local" },
			windows: { command: ["server"], cwd: "C:\\opt\\mcp", type: "local" },
		},
	});

	expect(result.servers.posix).toMatchObject({ cwd: "/opt/mcp" });
	expect(result.servers.relative).toMatchObject({
		cwd: path.resolve(workspace, "../mcp"),
	});
	expect(result.servers.windows).toMatchObject({ cwd: "C:\\opt\\mcp" });
});

test("invalid timeout phases are diagnosed and do not expose a partial server", () => {
	const result = resolveAsUser({
		mcp: {
			broken: {
				command: ["server"],
				timeout: { catalog: 0, execution: 1.5, startup: -1 },
				type: "local",
			},
		},
	});

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toHaveLength(3);
	expect(result.diagnostics.map(({ code }) => code)).toEqual([
		"invalid-timeout",
		"invalid-timeout",
		"invalid-timeout",
	]);
	expect(result.invalidServers).toHaveProperty("broken");
});

test("unknown fields and empty local commands fail closed per server", () => {
	const result = resolveAsUser({
		mcp: {
			badCommand: { command: [], type: "local" },
			unknownField: { command: ["server"], extraOption: true, type: "local" },
			valid: { command: ["server"], type: "local" },
		},
	});

	expect(Object.keys(result.servers)).toEqual(["valid"]);
	expect(result.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "invalid-server",
				serverName: "badCommand",
			}),
			expect.objectContaining({
				code: "invalid-field",
				serverName: "unknownField",
			}),
		])
	);
});

test("invalid URLs and unsupported OAuth are isolated without enabling either server", () => {
	const result = resolveAsUser({
		mcp: {
			badUrl: { type: "remote", url: "file:///etc/passwd" },
			good: { type: "remote", url: "https://mcp.example.test" },
			unsupportedAuth: {
				oauth: { clientId: "client" },
				type: "remote",
				url: "https://mcp.example.test/auth",
			},
		},
	});

	expect(Object.keys(result.servers)).toEqual(["good"]);
	expect(result.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ code: "invalid-url", serverName: "badUrl" }),
			expect.objectContaining({
				code: "unsupported-auth",
				serverName: "unsupportedAuth",
			}),
		])
	);
	expect(result.invalidServers).toHaveProperty("badUrl");
	expect(result.invalidServers).toHaveProperty("unsupportedAuth");
});

test("missing environment values are attributed to the supplying config layer", () => {
	const userOrigin: McpConfigOrigin = {
		path: "/home/test/.config/wincode/config.jsonc",
		scope: "user",
	};
	const document = {
		mcp: {
			private: {
				command: ["server"],
				environment: { TOKEN: "{env:MISSING_TOKEN}" },
				type: "local",
			},
		},
	};
	const userSource: McpConfigSource = { ...userOrigin, document };
	const result = resolve(document, {
		snapshot: {
			sourceFor: (field) =>
				field[0] === "mcp" && field[1] === "private"
					? userOrigin
					: projectOrigin,
			sources: [{ ...projectOrigin, document: {} }, userSource],
		},
	});

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toEqual([
		expect.objectContaining({
			code: "missing-env",
			path: `${userOrigin.path}:mcp.private.environment.TOKEN`,
			scope: "user",
			serverName: "private",
		}),
	]);
});

test("malformed scopes and scalar server entries produce diagnostics without crashing", () => {
	const malformedScope = { mcp: "not-an-object" };
	const scopeResult = resolve(malformedScope);
	const malformedEntries = { mcp: { scalar: false } };
	const entryResult = resolve(malformedEntries);

	expect(scopeResult.servers).toEqual({});
	expect(scopeResult.diagnostics).toEqual([
		expect.objectContaining({
			code: "invalid-scope",
			path: `${projectOrigin.path}:mcp`,
		}),
	]);
	expect(entryResult.servers).toEqual({});
	expect(entryResult.diagnostics).toEqual([
		expect.objectContaining({
			code: "invalid-server",
			path: `${projectOrigin.path}:mcp.scalar`,
			serverName: "scalar",
		}),
	]);
});

test("missing and unsupported server types are diagnosed instead of reaching the registry", () => {
	const result = resolve({
		mcp: {
			missingType: { command: ["server"] },
			unsupportedType: { command: ["server"], type: "container" },
		},
	});

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toHaveLength(2);
	expect(
		result.diagnostics.every(
			({ serverName }) =>
				serverName === "missingType" || serverName === "unsupportedType"
		)
	).toBe(true);
});

test("a project MCP definition replaces personal connection details without inheriting secrets", () => {
	const userToken = "private-user-token";
	const result = resolve(
		{
			mcp: {
				shared: { type: "remote", url: "https://project.example.test/mcp" },
			},
		},
		{
			env: { USER_TOKEN: userToken },
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" &&
					field[1] === "shared" &&
					(field[2] === "type" || field[2] === "url")
						? projectOrigin
						: userOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								shared: {
									headers: { Authorization: "{env:USER_TOKEN}" },
									type: "remote",
									url: "https://personal.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: {
							mcp: {
								shared: {
									type: "remote",
									url: "https://project.example.test/mcp",
								},
							},
						},
					},
				],
			},
		}
	);

	expect(result.servers.shared).toMatchObject({
		name: "shared",
		type: "remote",
		url: "https://project.example.test/mcp",
	});
	expect(result.servers.shared).not.toHaveProperty("headers");
	expect(JSON.stringify(result)).not.toContain(userToken);
});

test("an enabled-only project MCP entry overlays personal connection details", () => {
	const result = resolve(
		{
			mcp: {
				shared: {
					enabled: true,
					type: "remote",
					url: "https://personal.example.test/mcp",
				},
			},
		},
		{
			env: { USER_TOKEN: "private-user-token" },
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" && field[1] === "shared" && field[2] === "enabled"
						? projectOrigin
						: userOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								shared: {
									enabled: false,
									headers: { Authorization: "{env:USER_TOKEN}" },
									type: "remote",
									url: "https://personal.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: { mcp: { shared: { enabled: true } } },
					},
				],
			},
		}
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.shared).toMatchObject({
		disabled: false,
		headers: { Authorization: "private-user-token" },
		type: "remote",
		url: "https://personal.example.test/mcp",
	});
});

test("a partial project MCP definition cannot borrow personal server fields or credentials", () => {
	const userToken = "private-user-token";
	const result = resolve(
		{
			mcp: {
				shared: {
					headers: { Authorization: "{env:USER_TOKEN}" },
					url: "https://project.example.test/mcp",
				},
			},
		},
		{
			env: { USER_TOKEN: userToken },
			snapshot: {
				sourceFor: (field) =>
					field[0] === "mcp" && field[1] === "shared" && field[2] === "url"
						? projectOrigin
						: userOrigin,
				sources: [
					{
						...userOrigin,
						document: {
							mcp: {
								shared: {
									headers: { Authorization: "{env:USER_TOKEN}" },
									type: "remote",
									url: "https://personal.example.test/mcp",
								},
							},
						},
					},
					{
						...projectOrigin,
						document: {
							mcp: { shared: { url: "https://project.example.test/mcp" } },
						},
					},
				],
			},
		}
	);

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "invalid-server",
				path: `${projectOrigin.path}:mcp.shared.type`,
				scope: "project",
				serverName: "shared",
			}),
		])
	);
	expect(JSON.stringify(result)).not.toContain(userToken);
});
