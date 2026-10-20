import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentIdSchema } from "@wincode/agent-core";
import { discoverSubagentAgents } from "../src/agents";

const definition = (name: string, description: string, instructions: string) =>
	`---\nname: ${name}\ndescription: ${description}\nrole: subagent\ntools: [read, grep]\n---\n${instructions}\n`;

test("trusted project Markdown overrides user and package agents by name", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-agents-"));
	const builtinRoot = path.join(root, "package-agents");
	const userDataDir = path.join(root, "user-data");
	const workspace = path.join(root, "workspace");
	const paths = [
		[
			path.join(builtinRoot, "scout.md"),
			definition("scout", "Packaged scout", "Package instructions."),
		],
		[
			path.join(userDataDir, "agents", "nested", "scout.md"),
			definition("scout", "User scout", "User instructions."),
		],
		[
			path.join(workspace, ".wincode", "agents", "deep", "scout.md"),
			definition("scout", "Project scout", "Project instructions."),
		],
		[
			path.join(workspace, ".wincode", "agents", "project-only.md"),
			definition(
				"project-only",
				"Project-only agent",
				"Project-only instructions."
			),
		],
	] as const;

	try {
		for (const [filePath, contents] of paths) {
			await Bun.write(filePath, contents);
		}

		const trusted = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: [workspace],
			userDataDir,
		});
		expect(
			trusted.agents.find(({ agent }) => agent.id === "scout")?.agent
				.instructions
		).toBe("Project instructions.");
		expect(trusted.agents.map(({ agent }) => agent.id)).toContain(
			agentIdSchema.parse("project-only")
		);

		const untrusted = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: [],
			userDataDir,
		});
		expect(
			untrusted.agents.find(({ agent }) => agent.id === "scout")?.agent
				.instructions
		).toBe("User instructions.");
		expect(untrusted.agents.map(({ agent }) => agent.id)).not.toContain(
			agentIdSchema.parse("project-only")
		);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("a trusted disabled definition suppresses the lower-scope agent", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-disabled-agent-")
	);
	const builtinRoot = path.join(root, "package-agents");
	const userDataDir = path.join(root, "user-data");
	const workspace = path.join(root, "workspace");

	try {
		await Bun.write(
			path.join(builtinRoot, "scout.md"),
			definition("scout", "Packaged scout", "Package instructions.")
		);
		await Bun.write(
			path.join(workspace, ".wincode", "agents", "scout.md"),
			"---\nname: scout\ndescription: Disable scout\ndisabled: true\n---\n"
		);

		const discovered = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: [workspace],
			userDataDir,
		});
		expect(discovered.agents).toEqual([]);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("an invalid higher-scope Markdown file does not hide the packaged agent", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-invalid-agent-")
	);
	const builtinRoot = path.join(root, "package-agents");
	const userDataDir = path.join(root, "user-data");

	try {
		await Bun.write(
			path.join(builtinRoot, "scout.md"),
			definition("scout", "Packaged scout", "Package instructions.")
		);
		await Bun.write(
			path.join(userDataDir, "agents", "scout.md"),
			"---\nname: scout\nunknown: true\n---\nInvalid override.\n"
		);

		const discovered = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: [],
			userDataDir,
		});
		expect(discovered.agents).toHaveLength(1);
		expect(discovered.agents[0]?.agent.instructions).toBe(
			"Package instructions."
		);
		expect(discovered.diagnostics).toHaveLength(1);
		expect(discovered.diagnostics[0]).toContain("Ignored invalid Agent file");
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("a higher-scope Agent retains its exact unavailable Provider Model pin", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-agent-model-"));
	const builtinRoot = path.join(root, "package-agents");
	const userDataDir = path.join(root, "user-data");

	try {
		await Bun.write(
			path.join(builtinRoot, "scout.md"),
			definition("scout", "Packaged scout", "Package instructions.")
		);
		await Bun.write(
			path.join(userDataDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: User-pinned Provider Model.\nmodel: openai/unknown-model\n---\nUser instructions.\n"
		);

		const discovered = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: [],
			userDataDir,
		});
		expect(discovered.agents).toHaveLength(1);
		expect(discovered.agents[0]?.agent.instructions).toBe("User instructions.");
		expect(discovered.agents[0]?.model).toBe("openai/unknown-model");
		expect(discovered.diagnostics).toEqual([]);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Markdown Agent discovery preserves valid Thinking Levels without Catalog policy", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-invalid-agent-thinking-level-")
	);
	const userDataDir = path.join(root, "user-data");

	try {
		await Bun.write(
			path.join(userDataDir, "agents", "invalid-agent.md"),
			"---\nname: invalid-agent\ndescription: Unsupported thinking level.\nmodel: openai/gpt-5.6-luna\nthinkingLevel: minimal\n---\nRun a delegated task.\n"
		);

		const discovered = await discoverSubagentAgents({
			builtinRoot: path.join(root, "package-agents"),
			trustedProjectRoots: [],
			userDataDir,
		});
		expect(discovered.agents).toHaveLength(1);
		expect(discovered.agents[0]?.model).toBe("openai/gpt-5.6-luna");
		expect(discovered.agents[0]?.thinkingLevel).toBe("minimal");
		expect(discovered.diagnostics).toEqual([]);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
