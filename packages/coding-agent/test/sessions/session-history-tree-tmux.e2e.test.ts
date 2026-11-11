import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const smokeLauncher = path.join(
	repositoryRoot,
	"scripts/test-support/interactive-smoke-launcher.sh"
);
const tmuxTimeoutMs = 20_000;

const quoteShell = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

test(
	"tmux history navigation cancels, branches, resumes, reopens, and blocks failed restoration",
	async () => {
		const tmuxSession = `wincode-history-${crypto.randomUUID()}`;
		const smokeHome = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-history-smoke-")
		);
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
		const sendKeys = async (...keys: string[]): Promise<void> => {
			await runTmux(["send-keys", "-t", tmuxSession, ...keys]);
		};
		const sendPrompt = async (text: string): Promise<void> => {
			await sendKeys(text, "Enter");
		};
		const sendCommand = async (command: string): Promise<void> => {
			const description = {
				"/agents": "Switch agents",
				"/history": "Browse the current Session history tree",
				"/new": "Start a new session",
				"/sessions": "Browse past sessions",
			}[command as "/agents" | "/history" | "/new" | "/sessions"];
			if (description === undefined) {
				throw new Error(`No smoke command description for ${command}.`);
			}
			await sendKeys(command);
			await waitForFrame(
				(frame) => frame.includes(description),
				`the ${command} command suggestion`
			);
			await sendKeys("Tab");
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
		const waitForResponse = async (response: string): Promise<string> =>
			await waitForFrame(
				(frame) => frame.includes(response) && !frame.includes("Working..."),
				`Provider response ${response}`
			);
		const selectSmokeAgent = async (): Promise<void> => {
			await sendCommand("/agents");
			await waitForFrame(
				(frame) =>
					frame.includes("Search agents") && frame.includes("Terminal Smoke"),
				"the Terminal Smoke Agent picker"
			);
			await sendKeys("Enter");
			await waitForFrame(
				(frame) =>
					frame.includes("Ask anything...") &&
					frame.includes("terminal-smoke/fake"),
				"the selected fake Provider"
			);
		};
		const openHistory = async (): Promise<string> => {
			await sendCommand("/history");
			return await waitForFrame(
				(frame) =>
					frame.includes("Enter selects a history entry") &&
					!frame.includes("Loading Session history..."),
				"the history tree"
			);
		};

		try {
			await runTmux([
				"new-session",
				"-d",
				"-s",
				tmuxSession,
				"-x",
				"80",
				"-y",
				"24",
				"-c",
				repositoryRoot,
				"bash",
			]);
			sessionCreated = true;
			const launcherCommand = [
				`WINCODE_SMOKE_HOME=${quoteShell(smokeHome)}`,
				`WINCODE_SMOKE_BUN=${quoteShell(process.execPath)}`,
				quoteShell(smokeLauncher),
			].join(" ");
			await sendKeys(launcherCommand, "Enter");
			await waitForFrame(
				(frame) => frame.includes("Ask anything..."),
				"the composer"
			);
			await selectSmokeAgent();

			await sendPrompt("terminal smoke cancel");
			await waitForFrame(
				(frame) =>
					frame.includes("cancel-pending") && frame.includes("Working..."),
				"the fake Provider's cancellable response"
			);
			await sendPrompt("terminal smoke after cancel");
			await waitForFrame(
				(frame) => frame.includes("1 waiting"),
				"a queued Submission while the Provider is active"
			);
			await sendKeys("Escape");
			await Bun.sleep(100);
			await sendKeys("Escape");
			await waitForFrame(
				(frame) =>
					frame.includes("terminal smoke after cancel") &&
					!frame.includes("Working..."),
				"the cancelled turn and recalled queued Submission"
			);
			await sendKeys("Enter");
			await waitForResponse("after-cancel-ok");
			expect(
				await Bun.file(
					path.join(smokeHome, "workspace", ".smoke-cancelled")
				).exists()
			).toBe(true);

			await sendCommand("/new");
			await waitForFrame(
				(frame) =>
					frame.includes("Ask anything...") &&
					!frame.includes("after-cancel-ok"),
				"a new Session after cancellation"
			);
			await selectSmokeAgent();
			await sendPrompt("terminal smoke stream");
			await waitForResponse("smoke-stream-two");

			const treeFrame = await openHistory();
			expect(treeFrame).toContain("Current leaf: entry 2");
			expect(treeFrame).toContain("Record · user · terminal smoke stream");
			expect(treeFrame).toContain("L Record · assistant ·");
			await sendKeys("Up");
			await sendKeys("p");
			const previewFrame = await waitForFrame(
				(frame) => frame.includes("History entry 1"),
				"the original User entry preview"
			);
			expect(previewFrame).toContain("terminal smoke stream");
			await sendKeys("Escape");
			await waitForFrame(
				(frame) =>
					frame.includes("Enter selects a history entry") &&
					!frame.includes("History entry 1"),
				"the tree after closing its preview"
			);
			await sendKeys("C-Home");
			await waitForFrame(
				(frame) =>
					!frame.includes("Enter selects a history entry") &&
					frame.includes("Ask anything..."),
				"the composer after selecting the root"
			);

			await sendPrompt("branch from root");
			await waitForResponse("root-branch-only");
			const branchedFrame = await openHistory();
			expect(branchedFrame).toContain("Record · user · branch from root");
			expect(branchedFrame).toContain("Current leaf:");
			await sendKeys("Up");
			await sendKeys("Up");
			await sendKeys("p");
			const preservedPreview = await waitForFrame(
				(frame) => frame.includes("History entry 2"),
				"the preserved sibling branch preview"
			);
			expect(preservedPreview).toContain("smoke-stream-two");
			await sendKeys("Escape");
			await waitForFrame(
				(frame) =>
					frame.includes("Enter selects a history entry") &&
					!frame.includes("History entry 2"),
				"the tree after closing the sibling preview"
			);
			await sendKeys("Enter");
			await waitForFrame(
				(frame) =>
					!frame.includes("Enter selects a history entry") &&
					frame.includes("Ask anything..."),
				"the composer after returning to the preserved branch"
			);

			await sendPrompt("continue preserved path");
			await waitForResponse("preserved-path-ok");
			await sendCommand("/sessions");
			const sessionsBeforeSwitch = await waitForFrame(
				(frame) =>
					frame.includes("Search sessions") &&
					frame.includes("terminal smoke stream") &&
					frame.includes("terminal smoke cancel"),
				"both stored Sessions before switching away"
			);
			expect(sessionsBeforeSwitch).toContain("terminal smoke stream");
			expect(sessionsBeforeSwitch).toContain("terminal smoke cancel");
			await sendKeys("terminal smoke cancel");
			await waitForFrame(
				(frame) =>
					frame.includes("Sessions") && frame.includes("terminal smoke cancel"),
				"the other Session search result"
			);
			await sendKeys("Enter");
			await waitForFrame(
				(frame) =>
					frame.includes("terminal smoke cancel") &&
					!frame.includes("preserved-path-ok") &&
					frame.includes("Ask anything..."),
				"the other stored Session"
			);
			for (let step = 0; step < 16; step += 1) {
				await sendKeys("BSpace");
			}
			await waitForFrame(
				(frame) => !frame.includes("/new"),
				"the cleared new-session command draft"
			);
			await sendCommand("/sessions");
			await waitForFrame(
				(frame) => frame.includes("Search sessions"),
				"the stored Session list before reopening"
			);
			await sendKeys("terminal smoke stream");
			await waitForFrame(
				(frame) =>
					frame.includes("Sessions") && frame.includes("terminal smoke stream"),
				"the preserved-path Session search result"
			);
			await sendKeys("Enter");
			await waitForFrame(
				(frame) =>
					frame.includes("preserved-path-ok") &&
					frame.includes("Ask anything..."),
				"the reopened Session's selected-path transcript"
			);
			await sendPrompt("reopen preserved path");
			await waitForResponse("reopen-preserved-path-ok");
			await openHistory();
			for (let step = 0; step < 4; step += 1) {
				await sendKeys("Up");
			}
			await sendKeys("p");
			const inactiveBranchPreview = await waitForFrame(
				(frame) => frame.includes("History entry 5"),
				"the inactive branch endpoint preview"
			);
			expect(inactiveBranchPreview).toContain("root-branch-only");
			await sendKeys("Escape");
			await waitForFrame(
				(frame) =>
					frame.includes("Enter selects a history entry") &&
					!frame.includes("History entry 5"),
				"the tree before restoring the inactive branch"
			);
			await sendKeys("Enter");
			const restoreFailureFrame = await waitForFrame(
				(frame) => frame.includes("smoke-history-restore-failed"),
				"the committed-blocked restore failure UI"
			);
			expect(restoreFailureFrame).toContain("Current leaf:");
		} catch (error) {
			const framePath = process.env.WINCODE_E2E_FRAME_PATH;
			if (framePath && lastFrame.length > 0) {
				await Bun.write(framePath, lastFrame);
			}
			throw error;
		} finally {
			if (sessionCreated) {
				await runTmux(["kill-session", "-t", tmuxSession]).catch(
					() => undefined
				);
			}
			await removeTemporaryDirectory(smokeHome);
		}
	},
	{ timeout: 120_000 }
);
