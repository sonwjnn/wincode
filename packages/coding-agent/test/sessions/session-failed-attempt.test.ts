import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMessageId } from "@wincode/agent-core";
import type { ProviderChatRequest } from "@wincode/ai";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type {
	SessionCapabilities,
	SessionHost,
} from "@/modules/sessions/host/types";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { agentId } from "../support/identifiers";
import { successfulSessionWriteOutcome } from "../support/session-write-store";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const root = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-failed-attempt-")
);
afterAll(() => removeTemporaryDirectory(root));

/**
 * The provider answers the first call with one Tool Call, then fails provider
 * attempts until a test explicitly enables a successful retry.
 */
const openFailedAttemptSession = async (
	name: string,
	options: {
		contextOverflow?: boolean;
		overflowRecoveryAvailable?: boolean;
	} = {}
) => {
	const workspace = path.join(root, name);
	await fs.mkdir(workspace);
	const recorder = createFakeProviderRecorder();
	const requests: ProviderChatRequest[] = [];
	const fixture = path.join(process.cwd(), `.failed-attempt-${name}.txt`);
	await Bun.write(fixture, "failed attempt tool output");
	let providerCalls = 0;
	let retrySuccessEnabled = false;
	recorder.stepScript = async function* (request) {
		requests.push(request);
		providerCalls += 1;
		if (providerCalls === 1) {
			yield {
				input: { path: fixture },
				toolCallId: "failed-attempt-call",
				toolName: "read",
				type: "tool-call",
			};
		} else if (
			options.contextOverflow === true
				? providerCalls === 2
				: !retrySuccessEnabled && providerCalls <= 6
		) {
			throw new Error(
				options.contextOverflow === true
					? "The prompt exceeds the model context window."
					: "Provider is unavailable"
			);
		} else {
			yield { delta: "Recovered after retry", type: "text-delta" };
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	const databasePath = path.join(workspace, "sessions.sqlite");
	let services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
	});
	const capabilities = (): SessionCapabilities => {
		const base = services.capabilities;
		const overflowRecoveryAvailable = options.overflowRecoveryAvailable;
		return overflowRecoveryAvailable === undefined
			? base
			: {
					...base,
					getCompactionSettings: async (model, providerModel) => ({
						...(await base.getCompactionSettings(model, providerModel)),
						overflowRecoveryAvailable,
					}),
				};
	};
	const created = await services.store.createEmptySession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	const host: SessionHost = await capabilities()
		.getSessionHostManager()
		.openHost({
			capabilities: capabilities(),
			autoContinue: false,
			sessionId: created.id,
		});
	let liveHost = host;
	const run = async (input: {
		messageId?: SessionMessageId;
		userText: string;
	}) =>
		await liveHost.agentSession.send({
			agent: agentId("build"),
			...input,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
	const snapshot = () => liveHost.agentSession.getSnapshot();
	/** Replaces both the Host and its services on the same database. */
	const reopen = async (): Promise<void> => {
		await liveHost.shutdown();
		await services.shutdown();
		services = await openSessionServices({
			policy: { cwd: workspace, databasePath, workspace },
			sources: {
				createProviderCollection: () => createFakeProviderCollection(recorder),
			},
		});
		liveHost = await capabilities().getSessionHostManager().openHost({
			capabilities: capabilities(),
			autoContinue: false,
			sessionId: created.id,
		});
	};
	return {
		dispose: async () => {
			await liveHost.shutdown();
			await services.shutdown();
		},
		enableRetrySuccess: () => {
			retrySuccessEnabled = true;
		},
		fixture,
		getHost: () => liveHost,
		getStore: () => services.store,
		reopen,
		requests,
		run,
		snapshot,
	};
};

test("retrying a failed attempt drops its completed Tool Call results from the next request", async () => {
	const { dispose, fixture, requests, run, snapshot } =
		await openFailedAttemptSession("tool");
	try {
		await run({ userText: "Read the file" });
		expect(
			snapshot().transcript.some(
				(message) => message.metadata?.terminalOutcome === "failed"
			)
		).toBe(true);
		const userMessageId = snapshot().transcript.find(
			(message) => message.role === "user"
		)?.id;
		if (userMessageId === undefined) {
			throw new Error("The failed attempt has no durable user message.");
		}

		const requestsBeforeRetry = requests.length;
		const retry = await run({
			messageId: userMessageId,
			userText: "Read the file",
		});
		expect(retry).toMatchObject({ rejected: false });
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (requests.length > requestsBeforeRetry) {
				break;
			}
			await Bun.sleep(10);
		}
		expect(requests.length).toBeGreaterThan(requestsBeforeRetry);

		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).toContainEqual(
			expect.objectContaining({ text: "Read the file", type: "text" })
		);
		expect(content).not.toContainEqual(
			expect.objectContaining({ toolCallId: "failed-attempt-call" })
		);
		expect(
			snapshot().transcript.some((message) =>
				message.parts.some((part) => part.type === "tool-read")
			)
		).toBe(true);
	} finally {
		await dispose();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("unavailable overflow recovery omits failed tool output before a retry", async () => {
	const { dispose, fixture, requests, run, snapshot } =
		await openFailedAttemptSession("overflow-unavailable", {
			contextOverflow: true,
			overflowRecoveryAvailable: false,
		});
	try {
		const failed = await run({ userText: "Read the file" });
		expect(failed).toMatchObject({ rejected: false });
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const hasToolOutput = snapshot().context.some((message) =>
				message.parts.some((part) => part.type === "tool-read")
			);
			if (!hasToolOutput) {
				break;
			}
			await Bun.sleep(10);
		}
		const userMessageId = snapshot().transcript.find(
			(message) => message.role === "user"
		)?.id;
		if (userMessageId === undefined) {
			throw new Error(
				"The failed overflow attempt has no durable user message."
			);
		}
		const retry = await run({
			messageId: userMessageId,
			userText: "Read the file",
		});
		expect(retry).toMatchObject({ rejected: false });
		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).not.toContainEqual(
			expect.objectContaining({ toolCallId: "failed-attempt-call" })
		);
		expect(
			snapshot().transcript.some((message) =>
				message.parts.some((part) => part.type === "tool-read")
			)
		).toBe(true);
	} finally {
		await dispose();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("reopen re-omits a failed tool result after a later replacement edit", async () => {
	const { dispose, fixture, getHost, reopen, requests, run, snapshot } =
		await openFailedAttemptSession("replacement-after-failure");
	try {
		await run({ userText: "Read the file" });
		const failedToolMessage = snapshot().transcript.find((message) =>
			message.parts.some((part) => part.type === "tool-read")
		);
		if (failedToolMessage === undefined) {
			throw new Error("The failed attempt has no durable Tool Call result.");
		}
		await getHost().editContext({
			operationId: "replace-failed-tool-output",
			targetId: failedToolMessage.id,
			replacement: { text: "User-edited tool output" },
		});
		await reopen();
		const followUp = await run({
			userText: "Continue without the old failed result",
		});
		expect(followUp).toMatchObject({ rejected: false });
		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).not.toContainEqual(
			expect.objectContaining({ toolCallId: "failed-attempt-call" })
		);
		expect(content).not.toContainEqual(
			expect.objectContaining({
				output: "User-edited tool output",
				type: "tool-result",
			})
		);
		expect(
			snapshot().transcript.some((message) =>
				message.parts.some((part) => part.type === "tool-read")
			)
		).toBe(true);
	} finally {
		await dispose();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("reopening repairs a lost failed-attempt omission after a same-ID retry", async () => {
	const {
		dispose,
		enableRetrySuccess,
		fixture,
		getStore,
		reopen,
		requests,
		run,
		snapshot,
	} = await openFailedAttemptSession("same-id-retry-after-lost-omission");
	const store = getStore();
	const appendContextEdit = store.appendContextEdit;
	let lostOmission = false;
	store.appendContextEdit = async (sessionId, edit) => {
		if (edit.operationId.startsWith("omit-failed-")) {
			lostOmission = true;
			return successfulSessionWriteOutcome(edit.operationId);
		}
		return await appendContextEdit(sessionId, edit);
	};
	try {
		await run({ userText: "Read the file" });
		enableRetrySuccess();
		const userMessageId = snapshot().transcript.find(
			(message) => message.role === "user"
		)?.id;
		if (userMessageId === undefined) {
			throw new Error("The failed attempt has no durable user message.");
		}
		const requestsBeforeRetry = requests.length;
		const retry = await run({
			messageId: userMessageId,
			userText: "Read the file",
		});
		expect(retry).toMatchObject({ rejected: false });
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (requests.length > requestsBeforeRetry) {
				break;
			}
			await Bun.sleep(10);
		}
		expect(requests.length).toBeGreaterThan(requestsBeforeRetry);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (
				snapshot().transcript.some((message) =>
					message.parts.some(
						(part) =>
							part.type === "text" && part.text === "Recovered after retry"
					)
				)
			) {
				break;
			}
			await Bun.sleep(10);
		}
		const transcriptText = snapshot().transcript.flatMap(
			({ metadata, parts, role }) =>
				parts.flatMap((part) =>
					part.type === "text"
						? [{ role, outcome: metadata?.terminalOutcome, text: part.text }]
						: []
				)
		);
		expect(transcriptText).toContainEqual(
			expect.objectContaining({ text: "Recovered after retry" })
		);
		expect(lostOmission).toBe(true);

		await reopen();
		const requestsBeforeFollowUp = requests.length;
		const outcome = await run({ userText: "Continue after the retry" });
		expect(outcome).toMatchObject({ rejected: false });
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (requests.length > requestsBeforeFollowUp) {
				break;
			}
			await Bun.sleep(10);
		}
		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).not.toContainEqual(
			expect.objectContaining({ toolCallId: "failed-attempt-call" })
		);
		expect(content).toContainEqual(
			expect.objectContaining({ text: "Recovered after retry", type: "text" })
		);
	} finally {
		await dispose();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("a failed attempt stays omitted after reopening the Session", async () => {
	const { dispose, fixture, reopen, requests, run, snapshot } =
		await openFailedAttemptSession("reopen");
	try {
		await run({ userText: "Read the file" });
		const userMessageId = snapshot().transcript.find(
			(message) => message.role === "user"
		)?.id;
		if (userMessageId === undefined) {
			throw new Error("The failed attempt has no durable user message.");
		}
		await reopen();
		const outcome = await run({
			messageId: userMessageId,
			userText: "Read the file",
		});
		expect(outcome).toMatchObject({ rejected: false });
		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).not.toContainEqual(
			expect.objectContaining({ toolCallId: "failed-attempt-call" })
		);
	} finally {
		await dispose();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("a failed attempt omission failure blocks scheduling and is repaired on reopen", async () => {
	const { dispose, fixture, getStore, reopen, requests, run, snapshot } =
		await openFailedAttemptSession("partial-omission");
	const store = getStore();
	const appendContextEdit = store.appendContextEdit;
	let omissionWrites = 0;
	store.appendContextEdit = async (sessionId, edit) => {
		omissionWrites += 1;
		if (omissionWrites === 2) {
			return {
				error: {
					code: "session_log_write_indeterminate",
					message: "Injected indeterminate omission write.",
				},
				kind: "indeterminate",
				operationId: edit.operationId,
				requiresReconciliation: true,
			};
		}
		return await appendContextEdit(sessionId, edit);
	};
	try {
		await run({ userText: "Read the file" });
		const requestsBeforeRetry = requests.length;
		const blocked = await run({
			userText: "Do not run before omission recovery",
		});
		expect(blocked).toMatchObject({ rejected: true });
		expect(requests).toHaveLength(requestsBeforeRetry);

		await reopen();
		const userMessageId = snapshot().transcript.find(
			(message) => message.role === "user"
		)?.id;
		if (userMessageId === undefined) {
			throw new Error("The failed attempt has no durable user message.");
		}
		await run({ messageId: userMessageId, userText: "Read the file" });
		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).not.toContainEqual(
			expect.objectContaining({ toolCallId: "failed-attempt-call" })
		);
	} finally {
		await dispose();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("a completed turn keeps its Tool Call result in the next request", async () => {
	const workspace = path.join(root, "completed");
	await fs.mkdir(workspace);
	const recorder = createFakeProviderRecorder();
	const requests: ProviderChatRequest[] = [];
	const fixture = path.join(process.cwd(), ".failed-attempt-completed.txt");
	await Bun.write(fixture, "completed tool output");
	let providerCalls = 0;
	recorder.stepScript = async function* (request) {
		requests.push(request);
		providerCalls += 1;
		if (providerCalls === 1) {
			yield {
				input: { path: fixture },
				toolCallId: "completed-call",
				toolName: "read",
				type: "tool-call",
			};
		} else {
			yield { delta: "Finished", type: "text-delta" };
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	const databasePath = path.join(workspace, "sessions.sqlite");
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
	});
	const created = await services.store.createEmptySession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	const host: SessionHost = await services.capabilities
		.getSessionHostManager()
		.openHost({
			capabilities: services.capabilities,
			autoContinue: false,
			sessionId: created.id,
		});
	try {
		for (const userText of ["Read the file", "Summarize it"]) {
			await host.agentSession.send({
				agent: agentId("build"),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText,
			});
		}
		const content =
			requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
		expect(content).toContainEqual(
			expect.objectContaining({ toolCallId: "completed-call" })
		);
	} finally {
		await host.shutdown();
		await services.shutdown();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);
