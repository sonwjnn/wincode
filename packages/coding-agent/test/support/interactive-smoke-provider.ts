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
} from "@wincode/coding-agent";

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

const historyBranchResponse = (
	prompt: string,
	transcript: string
): FauxResponse | undefined => {
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
	if (prompt.includes("terminal smoke cancel")) {
		return { ...fauxText("cancel-pending"), waitForAbort: true };
	}
	if (prompt.includes("terminal smoke after cancel")) {
		return completedResponse(fauxText("after-cancel-ok"));
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
	plugin.onSessionStart((session) => {
		sessionSdk = session.sessionSdk;
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
	plugin.onSessionHistoryNavigated(() => {
		historyNavigationCount += 1;
		if (historyNavigationCount === 3) {
			throw new Error("smoke-history-restore-failed");
		}
	});
	plugin.registerProvider({
		connect: async () => ({ kind: "local-test" }),
		createProvider: () => createSmokeProvider(context.workspace),
		displayName: "Interactive Smoke",
		providerId: "terminal-smoke",
	});
};

export default interactiveSmokePlugin;
