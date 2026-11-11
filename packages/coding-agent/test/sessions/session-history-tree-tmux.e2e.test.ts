import { expect, test } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const smokeLauncher = path.join(
	repositoryRoot,
	"scripts/test-support/interactive-smoke-launcher.sh"
);
const tmuxTimeoutMs = 15_000;

test("tmux /history previews, cancels, and reopens at the same leaf", async () => {
	const tmuxSession = `wincode-history-${crypto.randomUUID()}`;
	let sessionCreated = false;
	let lastFrame = "";
	const runTmux = async (args: string[]): Promise<string> => {
		const result = await $`tmux ${args}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			throw new Error(
				`tmux ${args.join(" ")} failed: ${result.stderr.toString().trim()}`
			);
		}
		return result.text();
	};
	const waitForFrame = async (
		predicate: (frame: string) => boolean,
		description: string
	): Promise<string> => {
		const deadline = Date.now() + tmuxTimeoutMs;
		while (Date.now() < deadline) {
			lastFrame = await runTmux(["capture-pane", "-t", tmuxSession, "-p"]);
			if (predicate(lastFrame)) {
				return lastFrame;
			}
			await Bun.sleep(100);
		}
		throw new Error(`Timed out waiting for ${description}.`);
	};

	try {
		await runTmux([
			"new-session",
			"-d",
			"-s",
			tmuxSession,
			"-x",
			"64",
			"-y",
			"18",
			"-c",
			repositoryRoot,
		]);
		sessionCreated = true;
		await runTmux(["send-keys", "-t", tmuxSession, smokeLauncher, "Enter"]);
		await waitForFrame(
			(frame) => frame.includes("Ask anything..."),
			"the composer"
		);

		await runTmux([
			"send-keys",
			"-t",
			tmuxSession,
			"terminal smoke stream",
			"Enter",
		]);
		await waitForFrame(
			(frame) => frame.includes("smoke-stream-two"),
			"the fake Provider's completed response"
		);
		await runTmux(["send-keys", "-t", tmuxSession, "/history"]);
		await runTmux(["send-keys", "-t", tmuxSession, "Enter"]);
		const treeFrame = await waitForFrame(
			(frame) => frame.includes("Current leaf: entry 1"),
			"the history tree and current leaf"
		);
		expect(treeFrame).toContain("Read only");
		expect(treeFrame).toContain("L Record · user · terminal smoke stream");

		await runTmux(["send-keys", "-t", tmuxSession, "Enter"]);
		const previewFrame = await waitForFrame(
			(frame) => frame.includes("History entry 1"),
			"the selected entry preview"
		);
		expect(previewFrame).toContain("terminal smoke stream");

		await runTmux(["send-keys", "-t", tmuxSession, "Escape"]);
		await waitForFrame(
			(frame) => frame.includes("Search Session history"),
			"the tree after cancelling its preview"
		);
		await runTmux(["send-keys", "-t", tmuxSession, "Escape"]);
		await waitForFrame(
			(frame) =>
				!frame.includes("Search Session history") &&
				frame.includes("Ask anything..."),
			"the composer after cancelling the read-only tree"
		);

		await runTmux(["send-keys", "-t", tmuxSession, "/history"]);
		await runTmux(["send-keys", "-t", tmuxSession, "Enter"]);
		const reopenedFrame = await waitForFrame(
			(frame) => frame.includes("Current leaf: entry 1"),
			"the reopened history tree"
		);
		expect(reopenedFrame).toContain("L Record · user · terminal smoke stream");
		await runTmux(["send-keys", "-t", tmuxSession, "Escape"]);
		await runTmux(["send-keys", "-t", tmuxSession, "/exit", "Enter"]);
	} catch (error) {
		const framePath = process.env.WINCODE_E2E_FRAME_PATH;
		if (framePath && lastFrame.length > 0) {
			await Bun.write(framePath, lastFrame);
		}
		throw error;
	} finally {
		if (sessionCreated) {
			await runTmux(["kill-session", "-t", tmuxSession]).catch(() => undefined);
		}
	}
});
