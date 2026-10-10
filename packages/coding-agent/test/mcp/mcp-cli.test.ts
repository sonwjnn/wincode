import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runMcpCli } from "@/modules/application/mcp-cli";

const makeIo = () => {
	const stderr: string[] = [];
	const stdout: string[] = [];
	return {
		io: {
			stderr: { write: (text: string) => stderr.push(text) },
			stdinIsTTY: false,
			stdout: { write: (text: string) => stdout.push(text) },
		},
		stderr,
		stdout,
	};
};

const setup = async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-mcp-cli-"));
	const homeRoot = path.join(root, "home");
	const workspace = path.join(root, "workspace");
	await mkdir(homeRoot, { recursive: true });
	await mkdir(path.join(workspace, ".git"), { recursive: true });
	return { homeRoot, root, workspace };
};

test("non-TUI MCP add writes Pi-compatible config only to the user MCP file", async () => {
	const { homeRoot, root, workspace } = await setup();
	const { io, stderr, stdout } = makeIo();
	try {
		const code = await runMcpCli(
			["add", "docs", "--command", "bun", "--arg", "run", "--arg", "docs.ts"],
			workspace,
			io,
			{ homeRoot, userDataDir: path.join(homeRoot, "data") }
		);
		const userConfig = path.join(homeRoot, ".wincode", "mcp.json");
		const document = await Bun.file(userConfig).json();
		expect(code).toBe(0);
		expect(document).toEqual({
			mcpServers: {
				docs: { command: "bun", args: ["run", "docs.ts"] },
			},
		});
		expect(
			await Bun.file(path.join(homeRoot, ".wincode", "settings.json")).exists()
		).toBe(false);
		expect(stdout.join("")).toContain("Added MCP Server 'docs'");
		expect(stderr).toEqual([]);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("project MCP writes require explicit trust and stay in the project namespace", async () => {
	const { homeRoot, root, workspace } = await setup();
	const projectConfig = path.join(workspace, ".wincode", "mcp.json");
	try {
		const refused = makeIo();
		const refusedCode = await runMcpCli(
			[
				"add",
				"project_docs",
				"--url",
				"https://mcp.example.test",
				"--scope",
				"project",
			],
			workspace,
			refused.io,
			{ homeRoot, userDataDir: path.join(homeRoot, "data") }
		);
		expect(refusedCode).toBe(1);
		expect(refused.stderr.join("")).toContain("requires a trusted project");
		expect(await Bun.file(projectConfig).exists()).toBe(false);

		const trusted = makeIo();
		const trustedCode = await runMcpCli(
			[
				"add",
				"project_docs",
				"--url",
				"https://mcp.example.test",
				"--scope",
				"project",
				"--trust-project",
			],
			workspace,
			trusted.io,
			{ homeRoot, userDataDir: path.join(homeRoot, "data") }
		);
		expect(trustedCode).toBe(0);
		expect(await Bun.file(projectConfig).json()).toEqual({
			mcpServers: { project_docs: { url: "https://mcp.example.test" } },
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("MCP remove preserves unrelated servers in the owning document", async () => {
	const { homeRoot, root, workspace } = await setup();
	const userConfig = path.join(homeRoot, ".wincode", "mcp.json");
	await mkdir(path.dirname(userConfig), { recursive: true });
	await Bun.write(
		userConfig,
		JSON.stringify({
			mcpServers: {
				keep: { url: "https://keep.example.test" },
				remove: { url: "https://remove.example.test" },
			},
		})
	);
	try {
		const { io } = makeIo();
		const code = await runMcpCli(["remove", "remove"], workspace, io, {
			homeRoot,
			userDataDir: path.join(homeRoot, "data"),
		});
		expect(code).toBe(0);
		expect(await Bun.file(userConfig).json()).toEqual({
			mcpServers: { keep: { url: "https://keep.example.test" } },
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
