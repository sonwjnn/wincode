import { describe, expect, test } from "bun:test";
import { loadMcpConfig } from "./config";

const fileSystem = (files: Record<string, string>) => ({
	readFile: async (path: string) => {
		const value = files[path];
		if (value === undefined) {
			throw new Error("missing");
		}
		return value;
	},
});

describe("loadMcpConfig", () => {
	test("loads JSONC, merges scopes, resolves values, and applies defaults", async () => {
		const result = await loadMcpConfig({
			workspace: "/project",
			globalRoot: "/home/user",
			env: { TOKEN: "secret" },
			fs: fileSystem({
				"/home/user/opencode.jsonc": `// global\n{"mcp":{"timeout":5000,"servers":{"one":{"type":"local","command":["x"],"environment":{"TOKEN":"{env:TOKEN}"}},"remote":{"type":"remote","url":"https://example.com","headers":{"x":"g"}}}}}`,
				"/project/opencode.json": `{"mcp":{"servers":{"one":{"cwd":"tools","disabled":true},"remote":{"headers":{"y":"p"}}}}}`,
			}),
		});
		expect(result.servers).toEqual([
			{
				name: "one",
				type: "local",
				command: ["x"],
				cwd: "/project/tools",
				environment: { TOKEN: "secret" },
				disabled: true,
				timeout: 5000,
			},
			{
				name: "remote",
				type: "remote",
				url: "https://example.com",
				headers: { x: "g", y: "p" },
				disabled: false,
				timeout: 5000,
			},
		]);
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
		expect(result.servers.map((server) => server.name)).toEqual(["ok"]);
		expect(result.diagnostics.join(" ")).toContain("SECRET");
		expect(result.diagnostics.join(" ")).not.toContain("ftp://x");
	});
});
