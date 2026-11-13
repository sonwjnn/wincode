import * as path from "node:path";
import {
	createFauxProvider,
	type FauxCall,
	type FauxResponse,
	fauxText,
	type Provider,
} from "@wincode/ai";
import type {
	PluginFactory,
	PluginSessionContext,
	PluginSessionHistory,
} from "@wincode/coding-agent";
import { z } from "zod";

/** Successful smoke turns must distinguish completion from unknown. */
const completedResponse = (response: FauxResponse): FauxResponse => ({
	...response,
	events: [
		...(response.events ?? []),
		{ completion: { kind: "completed" }, type: "finish" },
	],
});

const requestPrompt = (request: FauxCall["request"]): string =>
	request.messages
		.findLast((message) => message.role === "user")
		?.content.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n") ?? "";

const requestTranscript = (request: FauxCall["request"]): string =>
	request.messages
		.flatMap((message) =>
			message.content.flatMap((part) =>
				part.type === "text" ? [part.text] : []
			)
		)
		.join("\n");

const readSmokeHistoryItems = async (
	history: PluginSessionHistory
): Promise<readonly string[]> => {
	const items: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const page = await history.read(
			cursor === undefined ? { limit: 50 } : { cursor, limit: 50 }
		);
		for (const entry of page.entries) {
			if (!entry.type.startsWith("smoke-item-")) {
				continue;
			}
			const payload = entry.payload;
			if (
				typeof payload !== "object" ||
				payload === null ||
				Array.isArray(payload)
			) {
				continue;
			}
			const event = payload as Record<string, unknown>;
			if (event.schemaVersion === 1 && typeof event.item === "string") {
				items.push(event.item);
			}
		}
		if (page.nextCursor === undefined) {
			return items;
		}
		cursor = page.nextCursor;
	}
};

const historyBranchResponse = (
	prompt: string,
	transcript: string
): FauxResponse | undefined => {
	if (prompt.includes("terminal smoke continue imported branch")) {
		const importedSelectedPath =
			transcript.includes("branch smoke selected answer") &&
			!transcript.includes("branch smoke sibling answer");
		return completedResponse(
			fauxText(
				importedSelectedPath
					? "imported-branch-only"
					: "imported-branch-includes-sibling"
			)
		);
	}
	if (prompt.includes("branch from root")) {
		return completedResponse(fauxText("root-branch-only"));
	}
	if (prompt.includes("turn excluded from selected ancestor")) {
		return completedResponse(fauxText("excluded-turn-response"));
	}
	if (prompt.includes("continue from non-root ancestor")) {
		const selectedAncestorContext =
			transcript.includes("ancestor source turn") &&
			!transcript.includes("turn excluded from selected ancestor");
		return completedResponse(
			fauxText(
				selectedAncestorContext ? "ancestor-path-only" : "wrong-ancestor-path"
			)
		);
	}
	if (prompt.includes("continue preserved path")) {
		const restoredOriginalPath =
			transcript.includes("smoke-stream-two") &&
			!transcript.includes("root-branch-only");
		return completedResponse(
			fauxText(
				restoredOriginalPath ? "preserved-path-ok" : "wrong-history-path"
			)
		);
	}
	if (prompt.includes("reopen preserved path")) {
		const restoredContinuedPath =
			transcript.includes("preserved-path-ok") &&
			!transcript.includes("root-branch-only");
		return completedResponse(
			fauxText(
				restoredContinuedPath
					? "reopen-preserved-path-ok"
					: "wrong-reopened-path"
			)
		);
	}
};

const forkedToolPathResponse = (
	prompt: string,
	transcript: string
): FauxResponse | undefined => {
	if (!prompt.includes("continue forked tool path")) {
		return;
	}
	const forkedToolPath =
		transcript.includes("tool-roundtrip-ok") &&
		!transcript.includes("root-branch-only");
	return completedResponse(
		fauxText(
			forkedToolPath
				? "fork-context-no-tool-replay-ok"
				: "wrong-forked-tool-context"
		)
	);
};

const historyToolResponse = (
	prompt: string,
	request: FauxCall["request"]
): FauxResponse | undefined => {
	const lastMessage = request.messages.at(-1);
	if (prompt.includes("terminal smoke history add")) {
		const item = prompt.includes("history add A") ? "A" : "B";
		if (lastMessage?.role !== "tool") {
			return completedResponse({
				events: [
					{
						input: { item },
						toolCallId: `smoke-history-add-${item}`,
						toolName: "plugin_interactive_smoke_history_add",
						type: "tool-call",
					},
				],
			});
		}
		const resultText = JSON.stringify(lastMessage.content);
		return completedResponse(
			fauxText(
				resultText.includes("errorText")
					? `history-tool-failure:${resultText}`
					: `history-event-added:${item}`
			)
		);
	}
	if (prompt.includes("terminal smoke history list")) {
		if (lastMessage?.role !== "tool") {
			return completedResponse({
				events: [
					{
						input: {},
						toolCallId: "smoke-history-list",
						toolName: "plugin_interactive_smoke_history_list",
						type: "tool-call",
					},
				],
			});
		}
		const resultText = JSON.stringify(lastMessage.content);
		let state = "none";
		if (resultText.includes('"A"')) {
			state = "A";
		} else if (resultText.includes('"B"')) {
			state = "B";
		}
		return completedResponse(fauxText(`history-state:${state}`));
	}
};

const toolResponse = (
	prompt: string,
	request: FauxCall["request"]
): FauxResponse | undefined => {
	if (!prompt.includes("terminal smoke tool")) {
		return;
	}
	const result = request.messages.at(-1);
	if (result?.role !== "tool") {
		return completedResponse({
			events: [
				{
					input: { path: "smoke-fixture.txt" },
					toolCallId: "smoke-read",
					toolName: "read",
					type: "tool-call",
				},
			],
		});
	}
	return JSON.stringify(result.content).includes("smoke-file-content")
		? completedResponse(fauxText("tool-roundtrip-ok"))
		: { error: "Read tool did not return the smoke fixture" };
};

const scriptedResponse = (
	prompt: string,
	transcript: string,
	request: FauxCall["request"]
): FauxResponse | undefined => {
	if (prompt.includes("terminal smoke history context probe")) {
		return completedResponse(
			fauxText(
				transcript.includes("smoke-private-history-payload")
					? "history-context-leak"
					: "history-context-clean"
			)
		);
	}
	if (prompt.includes("terminal smoke cancel")) {
		return { ...fauxText("cancel-pending"), waitForAbort: true };
	}
	if (prompt.includes("terminal smoke after cancel")) {
		return completedResponse(fauxText("after-cancel-ok"));
	}
	const historyResponse = historyToolResponse(prompt, request);
	if (historyResponse !== undefined) {
		return historyResponse;
	}
	const forkedToolResponse = forkedToolPathResponse(prompt, transcript);
	if (forkedToolResponse !== undefined) {
		return forkedToolResponse;
	}
	const branchResponse = historyBranchResponse(prompt, transcript);
	if (branchResponse !== undefined) {
		return branchResponse;
	}
	const scriptedToolResponse = toolResponse(prompt, request);
	if (scriptedToolResponse !== undefined) {
		return scriptedToolResponse;
	}
	if (prompt.includes("terminal smoke error")) {
		return { error: "smoke-scripted-outage" };
	}
	if (prompt.includes("terminal smoke recover")) {
		return completedResponse(fauxText("error-recovery-ok"));
	}
};

const createSmokeProvider = (workspace: string): Provider => {
	const faux = createFauxProvider({ id: "terminal-smoke", modelId: "fake" });
	const respond = (call: FauxCall): FauxResponse => {
		faux.appendResponses([respond]);
		const prompt = requestPrompt(call.request);
		const response = scriptedResponse(
			prompt,
			requestTranscript(call.request),
			call.request
		);
		if (response !== undefined) {
			return response;
		}
		return {
			...completedResponse(fauxText("smoke-stream-one", "smoke-stream-two")),
			delayMs: 1000,
		};
	};
	faux.setResponses([respond]);
	return {
		...faux.provider,
		async *streamChat(request, context) {
			await Bun.write(
				path.join(workspace, ".smoke-provider-request-seen"),
				"request"
			);
			const requestCountPath = path.join(
				workspace,
				".smoke-provider-request-count"
			);
			const previousRequestCount = Number(
				await Bun.file(requestCountPath)
					.text()
					.catch(() => "0")
			);
			await Bun.write(requestCountPath, String(previousRequestCount + 1));
			try {
				yield* faux.provider.streamChat(request, context);
			} finally {
				if (context.signal?.aborted) {
					await Bun.write(path.join(workspace, ".smoke-cancelled"), "aborted");
				}
			}
		},
	};
};

const interactiveSmokePlugin: PluginFactory = (api, context) => {
	const plugin = api.definePlugin({ id: "interactive_smoke" });
	let sessionSdk: PluginSessionContext["sessionSdk"];
	let historyNavigationCount = 0;
	const customHistoryEnabled = process.env.WINCODE_SMOKE_HISTORY === "1";
	const restoredHistoryBySession = new Map<string, readonly string[]>();
	const restoreSmokeHistory = async (
		session: PluginSessionContext
	): Promise<void> => {
		if (session.sessionHistory === undefined) {
			restoredHistoryBySession.delete(session.sessionId);
			return;
		}
		restoredHistoryBySession.set(
			session.sessionId,
			await readSmokeHistoryItems(session.sessionHistory)
		);
	};
	plugin.onSessionStart(async (session) => {
		sessionSdk = session.sessionSdk;
		if (customHistoryEnabled) {
			await restoreSmokeHistory(session);
		}
	});
	plugin.registerCommand({
		description:
			"Exercise continuation rejection at a non-terminal checkpoint.",
		name: "smoke-invalid-continue",
		handler: async ({ sessionId }) => {
			const operations = sessionSdk;
			if (sessionId === undefined || operations === undefined) {
				throw new Error("Session SDK is unavailable for the smoke command.");
			}
			const handle = await operations.openSession(sessionId, {
				autoContinue: false,
				view: false,
			});
			try {
				const outcome = await handle.continue();
				return outcome.kind === "rejected"
					? `Invalid continuation endpoint rejected: ${outcome.reason}`
					: `Unexpected continuation outcome: ${outcome.kind}`;
			} finally {
				await handle.dispose();
			}
		},
	});
	if (customHistoryEnabled) {
		plugin.onSessionHistoryNavigated(restoreSmokeHistory);
		const recordHistoryAction = async (): Promise<void> => {
			const actionCountPath = path.join(
				context.workspace,
				".smoke-history-action-count"
			);
			const previousCount = await Bun.file(actionCountPath)
				.text()
				.catch(() => "0");
			const count = Number.parseInt(previousCount, 10);
			await Bun.write(
				actionCountPath,
				String(Number.isNaN(count) ? 1 : count + 1)
			);
		};
		plugin.registerTool({
			name: "history_add",
			description: "Append a smoke custom event to the selected Session path.",
			executionMode: "sequential",
			inputSchema: z.object({ item: z.enum(["A", "B"]) }),
			handler: async ({ item }, { sessionHistory, sessionId, toolCallId }) => {
				if (sessionHistory === undefined) {
					return { type: "failure", errorText: "No Session is active." };
				}
				await recordHistoryAction();
				const operationId = new Bun.CryptoHasher("sha256")
					.update(toolCallId)
					.digest("hex");
				const type = `smoke-item-${item}`;
				await sessionHistory.append(
					type,
					{
						item,
						privateValue: "smoke-private-history-payload",
						schemaVersion: 1,
					},
					`smoke-history-${operationId}`
				);
				restoredHistoryBySession.set(
					sessionId,
					await readSmokeHistoryItems(sessionHistory)
				);
				return { output: { item, type }, type: "success" };
			},
		});
		plugin.registerTool({
			name: "history_list",
			description: "Read the reduced custom history state for this Session.",
			inputSchema: z.object({}),
			handler: async (_input, { sessionHistory, sessionId }) => {
				if (sessionHistory === undefined) {
					return { type: "failure", errorText: "No Session is active." };
				}
				const items =
					restoredHistoryBySession.get(sessionId) ??
					(await readSmokeHistoryItems(sessionHistory));
				return { output: { items }, type: "success" };
			},
		});
	} else {
		plugin.onSessionHistoryNavigated(() => {
			historyNavigationCount += 1;
			if (historyNavigationCount === 3) {
				throw new Error("smoke-history-restore-failed");
			}
		});
	}
	plugin.registerProvider({
		connect: async () => ({ kind: "local-test" }),
		createProvider: () => createSmokeProvider(context.workspace),
		displayName: "Interactive Smoke",
		providerId: "terminal-smoke",
	});
};

export default interactiveSmokePlugin;
