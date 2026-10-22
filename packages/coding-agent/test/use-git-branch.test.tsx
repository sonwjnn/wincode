import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { getGitRepositoryWebUrl } from "@/shared/git/get-git-branch";
import { useGitBranch } from "@/shared/git/use-git-branch";
import { runGit } from "./support/git";

type BranchObserver = { current: string | null | undefined };

function BranchProbe({
	cwd,
	observer,
}: {
	cwd: string;
	observer: BranchObserver;
}) {
	const branch = useGitBranch(cwd);
	observer.current = branch;
	return <text>{branch ?? "no branch"}</text>;
}
const expectBranch = async (
	setup: TestRendererSetup,
	observer: BranchObserver,
	branch: string
) => {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await act(async () => {
			await Bun.sleep(10);
			await setup.renderOnce();
		});
		if (observer.current === branch) {
			return;
		}
	}
	throw new Error(`Timed out waiting for branch ${branch}`);
};

describe("git repository metadata", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wincode-git-branch-hook-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test("resolves an SSH origin to the repository browser URL", async () => {
		await runGit(dir, ["init", "--initial-branch=main"]);
		await runGit(dir, [
			"remote",
			"add",
			"origin",
			"git@github.com:sonwjnn/wincode.git",
		]);

		expect(await getGitRepositoryWebUrl(dir)).toBe(
			"https://github.com/sonwjnn/wincode"
		);
	});

	test("preserves HTTPS origins when resolving the repository browser URL", async () => {
		await runGit(dir, ["init", "--initial-branch=main"]);
		await runGit(dir, [
			"remote",
			"add",
			"origin",
			"https://github.com/sonwjnn/wincode.git",
		]);

		expect(await getGitRepositoryWebUrl(dir)).toBe(
			"https://github.com/sonwjnn/wincode"
		);
	});

	test("updates after checkout without changing the workspace path", async () => {
		await runGit(dir, ["init", "--initial-branch=main"]);
		const observer: BranchObserver = { current: undefined };
		const setup = await testRender(
			<BranchProbe cwd={dir} observer={observer} />,
			{
				width: 80,
				height: 2,
			}
		);
		try {
			await expectBranch(setup, observer, "main");

			await runGit(dir, ["checkout", "-b", "feature/sidebar"]);
			await expectBranch(setup, observer, "feature/sidebar");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("updates a linked worktree after checkout replaces its HEAD", async () => {
		const repo = path.join(dir, "repo");
		const worktree = path.join(dir, "worktree");
		await fs.promises.mkdir(repo);
		await runGit(repo, ["init", "--initial-branch=main"]);
		await runGit(repo, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"initial",
		]);
		await runGit(repo, ["worktree", "add", "-b", "feature/first", worktree]);
		const observer: BranchObserver = { current: undefined };
		const setup = await testRender(
			<BranchProbe cwd={worktree} observer={observer} />,
			{
				width: 80,
				height: 2,
			}
		);
		try {
			await expectBranch(setup, observer, "feature/first");
			await runGit(worktree, ["checkout", "-b", "feature/next"]);
			await expectBranch(setup, observer, "feature/next");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
