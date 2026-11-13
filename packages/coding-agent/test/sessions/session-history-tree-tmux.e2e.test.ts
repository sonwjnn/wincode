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
const currentLeafPattern = /Current leaf: entry \d+/u;
const forkedSessionPattern = /Fork created: Session ([^ .]+)\./iu;
const sessionIdentityPattern = /Session ID: ([^ .]+)/u;
const sourceSessionIdentityPattern = /Forked from Session ([^ ]+)/u;

type TerminalSmokeSession = Readonly<{
	openHistory: () => Promise<string>;
	sendCommand: (command: string) => Promise<void>;
	sendKeys: (...keys: string[]) => Promise<void>;
	sendPrompt: (text: string) => Promise<void>;
	smokeHome: string;
	waitForFrame: (
		predicate: (frame: string) => boolean,
		description: string
	) => Promise<string>;
	waitForResponse: (response: string) => Promise<string>;
}>;

const quoteShell = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

const withTerminalSmoke = async (
	run: (session: TerminalSmokeSession) => Promise<void>,
	options: Readonly<{
		historyEnabled?: boolean;
		seedInvalidEndpoint?: boolean;
	}> = {}
): Promise<void> => {
	const tmuxSession = `wincode-history-${crypto.randomUUID()}`;
	const smokeHome = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-history-smoke-")
	);
	let sessionCreated = false;
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
	// The composer renders before it accepts a Submission, so Enter can be
	// swallowed on a slow host. Retry only while the draft is still visible and
	// the message has not reached the transcript.
	const composerBlock = (frame: string): string => {
		const lines = frame.split("\n");
		const start = lines.findLastIndex((line) =>
			line.trimStart().startsWith("╭")
		);
		if (start < 0) {
			return "";
		}
		const end = lines.findIndex(
			(line, index) => index > start && line.trimStart().startsWith("╰")
		);
		return lines
			.slice(start, end < 0 ? undefined : end)
			.join(" ")
			.replace(/\s+/gu, " ");
	};
	const sendPrompt = async (text: string): Promise<void> => {
		const normalized = text.replace(/\s+/gu, " ");
		await sendKeys(text, "Enter");
		const deadline = Date.now() + 15_000;
		await Bun.sleep(300);
		while (Date.now() < deadline) {
			const frame = await runTmux(["capture-pane", "-t", tmuxSession, "-p"]);
			const composer = composerBlock(frame);
			if (!composer.includes(normalized)) {
				return;
			}
			const outsideComposer = frame
				.split("\n")
				.filter((line) => !composer.includes(line.trim()))
				.join(" ")
				.replace(/\s+/gu, " ");
			if (outsideComposer.includes(normalized)) {
				return;
			}
			await sendKeys("Enter");
			await Bun.sleep(400);
		}
		throw new Error(`The composer did not submit: ${text}`);
	};
	const waitForFrame = async (
		predicate: (frame: string) => boolean,
		description: string
	): Promise<string> => {
		const deadline = Date.now() + tmuxTimeoutMs;
		let frame = "";
		while (Date.now() < deadline) {
			frame = await runTmux(["capture-pane", "-t", tmuxSession, "-p"]);
			if (predicate(frame)) {
				return frame;
			}
			await Bun.sleep(100);
		}
		throw new Error(
			`Timed out waiting for ${description}.\n--- pane ---\n${frame}`
		);
	};
	const sendCommand = async (command: string): Promise<void> => {
		const descriptions: Readonly<Record<string, string>> = {
			"/agents": "Switch agents",
			"/history": "Browse the current Session history tree",
			"/new": "Start a new session",
			"/sessions": "Browse past sessions",
			"/smoke-invalid-continue": "Exercise continuation rejection",
		};
		const description = descriptions[command];
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
			`WINCODE_SMOKE_INVALID_ENDPOINT=${options.seedInvalidEndpoint === true ? "1" : "0"}`,
			`WINCODE_SMOKE_HISTORY=${options.historyEnabled === true ? "1" : "0"}`,
			quoteShell(smokeLauncher),
		].join(" ");
		await sendKeys(launcherCommand, "Enter");
		await waitForFrame(
			(frame) => frame.includes("Ask anything..."),
			"the composer"
		);
		await selectSmokeAgent();
		await run({
			openHistory,
			sendCommand,
			sendKeys,
			sendPrompt,
			smokeHome,
			waitForFrame,
			waitForResponse,
		});
	} finally {
		if (sessionCreated) {
			await runTmux(["kill-session", "-t", tmuxSession]).catch(() => undefined);
		}
		await removeTemporaryDirectory(smokeHome);
	}
};

test(
	"Escape cancels the active turn and recalls its queued Submission",
	async () => {
		await withTerminalSmoke(
			async ({
				sendPrompt,
				sendKeys,
				smokeHome,
				waitForFrame,
				waitForResponse,
			}) => {
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
			}
		);
	},
	{ timeout: 120_000 }
);

test(
	"Active and queued work reject history navigation without changing the branch",
	async () => {
		await withTerminalSmoke(
			async ({ openHistory, sendKeys, sendPrompt, waitForFrame }) => {
				await sendPrompt("terminal smoke cancel");
				await waitForFrame(
					(frame) =>
						frame.includes("cancel-pending") && frame.includes("Working..."),
					"the fake Provider's cancellable response"
				);
				await openHistory();
				await sendKeys("Enter");
				let refusalFrame = await waitForFrame(
					(frame) => frame.includes("Cannot navigate Session history"),
					"history navigation refusal during an active turn"
				);
				expect(refusalFrame).toContain("Cannot navigate Session history");
				await sendKeys("Escape");
				await waitForFrame(
					(frame) => !frame.includes("Enter selects a history entry"),
					"the composer after closing the history tree"
				);

				await sendPrompt("terminal smoke after cancel");
				await waitForFrame(
					(frame) => frame.includes("1 waiting"),
					"a queued Submission while the Provider is active"
				);
				await openHistory();
				await sendKeys("C-Home");
				refusalFrame = await waitForFrame(
					(frame) => frame.includes("Cannot navigate Session history"),
					"history navigation refusal while a Submission is queued"
				);
				expect(refusalFrame).toContain("Current leaf:");
			}
		);
	},
	{ timeout: 120_000 }
);

test(
	"History navigation preserves a sibling branch across Session switch and reopen",
	async () => {
		await withTerminalSmoke(
			async ({
				openHistory,
				sendCommand,
				sendKeys,
				sendPrompt,
				waitForFrame,
				waitForResponse,
			}) => {
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
				await sendCommand("/new");
				await waitForFrame(
					(frame) =>
						frame.includes("Ask anything...") &&
						!frame.includes("preserved-path-ok"),
					"a second Session before switching back"
				);
				await sendCommand("/agents");
				await waitForFrame(
					(frame) =>
						frame.includes("Search agents") && frame.includes("Terminal Smoke"),
					"the Terminal Smoke Agent picker for the second Session"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						frame.includes("Ask anything...") &&
						frame.includes("terminal-smoke/fake"),
					"the fake Provider on the second Session"
				);
				await sendPrompt("secondary smoke session");
				await waitForResponse("smoke-stream-two");
				for (let step = 0; step < 16; step += 1) {
					await sendKeys("BSpace");
				}
				await waitForFrame(
					(frame) => !frame.includes("/new"),
					"the cleared new-session command draft"
				);

				await sendCommand("/sessions");
				const sessionsFrame = await waitForFrame(
					(frame) =>
						frame.includes("Search sessions") &&
						frame.includes("terminal smoke stream") &&
						frame.includes("secondary smoke session"),
					"both stored Sessions before switching"
				);
				expect(sessionsFrame).toContain("terminal smoke stream");
				await sendKeys("terminal smoke stream");
				await waitForFrame(
					(frame) =>
						frame.includes("Sessions") &&
						frame.includes("terminal smoke stream"),
					"the branched Session search result"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) => frame.includes("preserved-path-ok"),
					"the reopened Session's selected-path transcript"
				);
				for (let step = 0; step < 16; step += 1) {
					await sendKeys("BSpace");
				}
				await waitForFrame(
					(frame) =>
						!frame.includes("/new") && frame.includes("Ask anything..."),
					"the cleared command draft after reopening"
				);
				await sendPrompt("reopen preserved path");
				await waitForResponse("reopen-preserved-path-ok");
			}
		);
	},
	{ timeout: 120_000 }
);

test(
	"Fork and Rewind from selected history checkpoints preserve the source Session",
	async () => {
		await withTerminalSmoke(
			async ({
				openHistory,
				sendCommand,
				sendKeys,
				sendPrompt,
				smokeHome,
				waitForFrame,
				waitForResponse,
			}) => {
				await sendPrompt("terminal smoke tool");
				await waitForResponse("tool-roundtrip-ok");
				await openHistory();
				await sendKeys("C-Home");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting the root"
				);
				await sendPrompt("branch from root");
				await waitForResponse("root-branch-only");

				await openHistory();
				await sendKeys("Up");
				await sendKeys("Up");
				await sendKeys("p");
				const toolCheckpointPreview = await waitForFrame(
					(frame) => frame.includes("History entry 3"),
					"the inactive sibling Tool Call checkpoint preview"
				);
				expect(toolCheckpointPreview).toContain("tool-roundtrip-ok");
				expect(toolCheckpointPreview).toContain("inactive branch");
				await sendKeys("Escape");
				const sourceTreeBeforeFork = await waitForFrame(
					(frame) =>
						frame.includes("Enter selects a history entry") &&
						!frame.includes("History entry "),
					"the tree after closing the checkpoint preview"
				);
				const currentLeaf = (frame: string): string | undefined =>
					currentLeafPattern.exec(frame)?.[0];
				const originalLeaf = currentLeaf(sourceTreeBeforeFork);
				const providerRequestCountPath = path.join(
					smokeHome,
					"workspace",
					".smoke-provider-request-count"
				);
				const requestsBeforeFork = Number(
					await Bun.file(providerRequestCountPath).text()
				);
				if (originalLeaf === undefined) {
					throw new Error("The source history tree omitted its current leaf.");
				}

				await sendKeys("f");
				const forkFrame = await waitForFrame(
					(frame) => frame.includes("Fork created: Session "),
					"the independent Fork result"
				);
				const normalizedForkFrame = forkFrame.replace(/\s+/gu, " ");
				expect(normalizedForkFrame).toContain("Source Session remains open.");
				expect(currentLeaf(forkFrame)).toBe(originalLeaf);
				const independentForkId = forkedSessionPattern.exec(forkFrame)?.[1];
				if (independentForkId === undefined) {
					throw new Error(
						"The independent Fork result omitted its Session ID."
					);
				}

				await sendKeys("r");
				const rewoundFrame = await waitForFrame(
					(frame) =>
						frame.includes("Session ID: ") &&
						frame.includes("Forked from Session "),
					"the new Rewind Session identity"
				);
				const normalizedRewoundFrame = rewoundFrame.replace(/\s+/gu, " ");
				expect(normalizedRewoundFrame).toContain("terminal smoke tool");
				expect(normalizedRewoundFrame).toContain("tool-roundtrip-ok");
				expect(normalizedRewoundFrame).not.toContain("root-branch-only");
				const childId = sessionIdentityPattern.exec(rewoundFrame)?.[1];
				const sourceId = sourceSessionIdentityPattern.exec(rewoundFrame)?.[1];
				if (childId === undefined || sourceId === undefined) {
					throw new Error("The Rewind Session omitted its fork identity.");
				}
				expect(childId).not.toBe(sourceId);
				expect(childId).not.toBe(independentForkId);
				expect(Number(await Bun.file(providerRequestCountPath).text())).toBe(
					requestsBeforeFork
				);
				await sendPrompt("continue forked tool path");
				await waitForResponse("fork-context-no-tool-replay-ok");
				expect(Number(await Bun.file(providerRequestCountPath).text())).toBe(
					requestsBeforeFork + 1
				);

				await sendCommand("/sessions");
				await waitForFrame(
					(frame) => frame.includes("Search sessions"),
					"the Session picker for returning to the source"
				);
				await sendKeys(sourceId);
				await waitForFrame(
					(frame) => frame.includes("terminal smoke tool"),
					"the source Session matched by its identity"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						frame.includes("Ask anything...") &&
						frame.includes("root-branch-only") &&
						!frame.includes("Forked from Session"),
					"the original Session after returning from its fork"
				);
				await openHistory();
				await sendKeys("branch from root");
				const sourceTree = await waitForFrame(
					(frame) => frame.includes("branch from root"),
					"the original branch after returning from the fork"
				);
				expect(currentLeaf(sourceTree)).toBe(originalLeaf);
			},
			{ historyEnabled: true }
		);
	},
	{ timeout: 120_000 }
);

test(
	"Selecting a non-root ancestor continues with only that ancestor's context",
	async () => {
		await withTerminalSmoke(
			async ({
				openHistory,
				sendKeys,
				sendPrompt,
				waitForFrame,
				waitForResponse,
			}) => {
				await sendPrompt("ancestor source turn");
				await waitForResponse("smoke-stream-two");
				await sendPrompt("turn excluded from selected ancestor");
				await waitForResponse("excluded-turn-response");

				const treeFrame = await openHistory();
				expect(treeFrame).toContain("Current leaf: entry 4");
				await sendKeys("Up");
				await sendKeys("Up");
				await sendKeys("p");
				const ancestorPreview = await waitForFrame(
					(frame) => frame.includes("History entry 2"),
					"the non-root ancestor preview"
				);
				expect(ancestorPreview).toContain("smoke-stream-two");
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						frame.includes("Enter selects a history entry") &&
						!frame.includes("History entry 2"),
					"the tree after closing its ancestor preview"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting a non-root ancestor"
				);

				await sendPrompt("continue from non-root ancestor");
				await waitForResponse("ancestor-path-only");
				await openHistory();
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("ancestor-path-only"),
					"the composer after continuing on the ancestor branch"
				);
			}
		);
	},
	{ timeout: 120_000 }
);

test(
	"Continue at a non-terminal history endpoint is rejected before a Provider request",
	async () => {
		await withTerminalSmoke(
			async ({
				openHistory,
				sendCommand,
				sendKeys,
				smokeHome,
				waitForFrame,
			}) => {
				await sendCommand("/sessions");
				await waitForFrame(
					(frame) =>
						frame.includes("Search sessions") &&
						frame.includes("Invalid endpoint smoke fixture"),
					"the seeded non-terminal history Session"
				);
				await sendKeys("Invalid endpoint smoke fixture");
				await waitForFrame(
					(frame) =>
						frame.includes("Sessions") &&
						frame.includes("Invalid endpoint smoke fixture"),
					"the filtered invalid-endpoint Session"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						frame.includes("non-terminal assistant checkpoint") &&
						!frame.includes("Search sessions"),
					"the Session ending at a non-terminal checkpoint"
				);
				for (let step = 0; step < 16; step += 1) {
					await sendKeys("BSpace");
				}
				await waitForFrame(
					(frame) =>
						!frame.includes("/sessions") && frame.includes("Ask anything..."),
					"the cleared composer in the selected Session"
				);

				const treeFrame = await openHistory();
				expect(treeFrame).toContain("Current leaf: entry ");
				expect(treeFrame).toContain(
					"L Record · assistant · non-terminal assistant checkpoint"
				);
				await sendKeys("p");
				const previewFrame = await waitForFrame(
					(frame) => frame.includes("History entry "),
					"the non-terminal checkpoint preview"
				);
				expect(previewFrame).toContain("non-terminal assistant checkpoint");
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						frame.includes("Enter selects a history entry") &&
						!frame.includes("History entry "),
					"the history tree after closing its preview"
				);
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after previewing the invalid endpoint"
				);

				await sendCommand("/smoke-invalid-continue");
				await sendKeys("Enter");
				const rejectionFrame = await waitForFrame(
					(frame) =>
						frame.includes("Invalid continuation endpoint rejected") &&
						frame.includes("completed Tool Call"),
					"the visible continuation rejection"
				);
				expect(rejectionFrame.replace(/\s+/g, " ")).toContain(
					"Agent Session can only continue"
				);
				expect(
					await Bun.file(
						path.join(smokeHome, "workspace", ".smoke-provider-request-seen")
					).exists()
				).toBe(false);
			},
			{ seedInvalidEndpoint: true }
		);
	},
	{ timeout: 120_000 }
);

test(
	"Plugin custom entries stay opaque in the tree and restore the selected branch interactively",
	async () => {
		await withTerminalSmoke(
			async ({
				openHistory,
				sendKeys,
				sendPrompt,
				smokeHome,
				waitForFrame,
				waitForResponse,
			}) => {
				await sendPrompt("terminal smoke history add A");
				await waitForResponse("history-event-added:A");
				const firstTree = await openHistory();
				expect(firstTree).toContain(
					"Plugin Entry · interactive_smoke / smoke-item-A"
				);
				await sendKeys("smoke-item-A");
				await waitForFrame(
					(frame) =>
						frame.includes("Plugin Entry · interactive_smoke / smoke-item-A"),
					"the filtered branch A custom entry"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting the branch A event"
				);
				await openHistory();
				await sendKeys("p");
				const preview = await waitForFrame(
					(frame) =>
						frame.includes("Plugin history payload is intentionally hidden"),
					"the opaque Plugin event preview"
				);
				expect(preview).not.toContain("smoke-private-history-payload");
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						frame.includes("Enter selects a history entry") &&
						!frame.includes("Plugin history payload is intentionally hidden"),
					"the tree after closing the Plugin event preview"
				);
				await sendKeys("C-Home");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting the root"
				);

				await sendPrompt("terminal smoke history add B");
				await waitForResponse("history-event-added:B");
				await openHistory();
				await sendKeys("smoke-item-A");
				await waitForFrame(
					(frame) =>
						frame.includes("Plugin Entry · interactive_smoke / smoke-item-A"),
					"the filtered branch A custom entry"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting branch A"
				);
				await sendPrompt("terminal smoke history list");
				await waitForResponse("history-state:A");

				await openHistory();
				await sendKeys("smoke-item-B");
				await waitForFrame(
					(frame) =>
						frame.includes("Plugin Entry · interactive_smoke / smoke-item-B"),
					"the filtered branch B custom entry"
				);
				await sendKeys("Enter");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting branch B"
				);
				await sendPrompt("terminal smoke history list");
				await waitForResponse("history-state:B");
				expect(
					await Bun.file(
						path.join(smokeHome, "workspace", ".smoke-history-action-count")
					).text()
				).toBe("2");

				await sendPrompt("terminal smoke history context probe");
				await waitForResponse("history-context-clean");
			},
			{ historyEnabled: true }
		);
	},
	{ timeout: 120_000 }
);

test(
	"Selecting an inactive branch reports the committed Plugin restore failure",
	async () => {
		await withTerminalSmoke(
			async ({
				openHistory,
				sendKeys,
				sendPrompt,
				waitForFrame,
				waitForResponse,
			}) => {
				await sendPrompt("terminal smoke stream");
				await waitForResponse("smoke-stream-two");
				await openHistory();
				await sendKeys("C-Home");
				await waitForFrame(
					(frame) =>
						!frame.includes("Enter selects a history entry") &&
						frame.includes("Ask anything..."),
					"the composer after selecting the root"
				);

				await sendPrompt("branch from root");
				await waitForResponse("root-branch-only");
				await openHistory();
				await sendKeys("Up");
				await sendKeys("Up");
				await sendKeys("p");
				const preservedPreview = await waitForFrame(
					(frame) => frame.includes("History entry 2"),
					"the preserved branch endpoint preview"
				);
				expect(preservedPreview).toContain("smoke-stream-two");
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						frame.includes("Enter selects a history entry") &&
						!frame.includes("History entry 2"),
					"the tree before selecting the preserved branch"
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

				await openHistory();
				let branchPreview = "";
				for (let attempt = 0; attempt < 12; attempt += 1) {
					await sendKeys("p");
					branchPreview = await waitForFrame(
						(frame) => frame.includes("History entry "),
						"the selected history entry preview"
					);
					if (branchPreview.includes("root-branch-only")) {
						break;
					}
					await sendKeys("Escape");
					await waitForFrame(
						(frame) =>
							frame.includes("Enter selects a history entry") &&
							!frame.includes("History entry "),
						"the tree before inspecting the next history entry"
					);
					await sendKeys("Up");
				}
				expect(branchPreview).toContain("root-branch-only");
				await sendKeys("Escape");
				await waitForFrame(
					(frame) =>
						frame.includes("Enter selects a history entry") &&
						!frame.includes("History entry "),
					"the tree before restoring the inactive branch"
				);
				await sendKeys("Enter");
				const restoreFailureFrame = await waitForFrame(
					(frame) => frame.includes("smoke-history-restore-failed"),
					"the committed-blocked restore failure UI"
				);
				expect(restoreFailureFrame).toContain("Current leaf:");
			}
		);
	},
	{ timeout: 120_000 }
);
