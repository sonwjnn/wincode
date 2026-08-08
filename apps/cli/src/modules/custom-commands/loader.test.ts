import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverCustomCommandCandidates } from "./discovery";
import { loadCustomCommands } from "./loader";
import type { CustomCommandCandidate } from "./types";

const makeCandidates = async (
	dirs: Array<{ dir: string; files: Record<string, string> }>
): Promise<CustomCommandCandidate[]> => {
	const root = join(tmpdir(), `custom-commands-${crypto.randomUUID()}`);
	const candidates: CustomCommandCandidate[] = [];
	for (const { dir, files } of dirs) {
		for (const [name, source] of Object.entries(files)) {
			const directory = join(root, dir);
			await mkdir(directory, { recursive: true });
			const filePath = join(directory, name);
			await writeFile(filePath, source);
			candidates.push({
				filePath,
				scope: dir.startsWith("home") ? "global" : "project",
			});
		}
	}
	return candidates;
};

describe("loadCustomCommands", () => {
	test("loads custom commands from markdown files with frontmatter", async () => {
		const candidates = await makeCandidates([
			{
				dir: "home/.wincode/commands",
				files: {
					"test.md":
						"---\ndescription: Run tests with coverage\n---\nRun the full test suite.",
				},
			},
		]);
		expect(await loadCustomCommands(candidates)).toEqual([
			{
				description: "Run tests with coverage",
				kind: "custom",
				name: "test",
				template: "Run the full test suite.",
				value: "/test",
			},
		]);
	});

	test("prefers the project command over the global command with the same name", async () => {
		const candidates = await makeCandidates([
			{
				dir: "home/.wincode/commands",
				files: { "test.md": "---\ndescription: global\n---\nGlobal template." },
			},
			{
				dir: "project/.wincode/commands",
				files: {
					"test.md": "---\ndescription: project\n---\nProject template.",
				},
			},
		]);
		const commands = await loadCustomCommands(candidates);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({
			description: "project",
			name: "test",
			template: "Project template.",
		});
	});

	test("drops custom commands that collide with built-in commands", async () => {
		const candidates = await makeCandidates([
			{
				dir: "project/.wincode/commands",
				files: {
					"new.md": "---\n---\nStart a new conversation.",
					"exit.md": "---\n---\nQuit.",
					"review.md": "---\n---\nReview code.",
				},
			},
		]);
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (message?: unknown) => warnings.push(String(message));
		try {
			const names = (await loadCustomCommands(candidates)).map(
				(command) => command.name
			);
			expect(names).toEqual(["review"]);
			expect(warnings).toHaveLength(2);
			expect(warnings[0]).toContain('"/new"');
			expect(warnings[0]).toContain("collides with a built-in command");
		} finally {
			console.warn = warn;
		}
	});

	test("skips files with invalid frontmatter and non-markdown names", async () => {
		const candidates = await makeCandidates([
			{
				dir: "project/.wincode/commands",
				files: {
					"broken.md": "---\ndescription: never closes",
					"good.md": "---\n---\nFine.",
					"notes.txt": "not a command",
				},
			},
		]);
		// Discovery only yields .md candidates, so the .txt file never reaches
		// the loader; broken frontmatter is skipped best-effort.
		expect(
			(await loadCustomCommands(candidates)).map((command) => command.name)
		).toEqual(["good"]);
	});

	test("sorts commands by name", async () => {
		const candidates = await makeCandidates([
			{
				dir: "home/.wincode/commands",
				files: {
					"zebra.md": "---\n---\nZ",
					"alpha.md": "---\n---\nA",
					"mango.md": "---\n---\nM",
				},
			},
		]);
		expect(
			(await loadCustomCommands(candidates)).map((command) => command.name)
		).toEqual(["alpha", "mango", "zebra"]);
	});

	test("returns an empty list for no candidates", async () => {
		expect(await loadCustomCommands([])).toEqual([]);
	});
});

describe("discoverCustomCommandCandidates", () => {
	test("scans global and project command folders in precedence order", async () => {
		const root = join(tmpdir(), `custom-discovery-${crypto.randomUUID()}`);
		const home = join(root, "home");
		const repo = join(root, "repo");
		const cwd = join(repo, "packages", "app");
		await mkdir(join(repo, ".git"), { recursive: true });
		const files = {
			"home/.wincode/commands/test.md": "---\n---\nG",
			"repo/.wincode/commands/repo.md": "---\n---\nR",
			"repo/packages/app/.wincode/commands/local.md": "---\n---\nL",
			"home/.wincode/commands/nested/skip.md": "---\n---\nS",
			"repo/packages/app/.wincode/commands/notes.txt": "not a command",
		};
		for (const [path, source] of Object.entries(files)) {
			const filePath = join(root, path);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, source);
		}
		const candidates = discoverCustomCommandCandidates(cwd, home);
		expect(candidates.map((candidate) => candidate.scope)).toEqual([
			"global",
			"project",
			"project",
		]);
		expect(candidates.map((candidate) => candidate.filePath)).toEqual([
			join(home, ".wincode", "commands", "test.md"),
			join(repo, ".wincode", "commands", "repo.md"),
			join(cwd, ".wincode", "commands", "local.md"),
		]);
	});
});
