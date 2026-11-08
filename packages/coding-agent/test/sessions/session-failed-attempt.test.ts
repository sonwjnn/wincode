import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMessageId } from "@wincode/agent-core";
import type { ProviderChatRequest } from "@wincode/ai";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import type { SessionServices } from "@/modules/sessions/host/session-services";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { SessionHost } from "@/modules/sessions/host/types";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { agentId } from "../support/identifiers";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const root = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-failed-attempt-")
);
afterAll(() => removeTemporaryDirectory(root));

/**
 * The provider answers the first call with one Tool Call, fails every retry the
 * runtime makes of that attempt, and only answers once the test retries.
 */
const openFailedAttemptSession = async (name: string) => {
	const workspace = path.join(root, name);
	await fs.mkdir(workspace);
	const recorder = createFakeProviderRecorder();
	const requests: ProviderChatRequest[] = [];
	const fixture = path.join(process.cwd(), `.failed-attempt-${name}.txt`);
	await Bun.write(fixture, "failed attempt tool output");
	let providerCalls = 0;
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
		} else if (providerCalls <= 6) {
			throw new Error("Provider is unavailable");
		} else {
			yield { delta: "Recovered after retry", type: "text-delta" };
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
		const reopenedServices: SessionServices = await openSessionServices({
			policy: { cwd: workspace, databasePath, workspace },
			sources: {
				createProviderCollection: () => createFakeProviderCollection(recorder),
			},
		});
		liveHost = await reopenedServices.capabilities
			.getSessionHostManager()
			.openHost({
				capabilities: reopenedServices.capabilities,
				autoContinue: false,
				sessionId: created.id,
			});
	};
	return {
		fixture,
		host: () => liveHost,
		reopen,
		requests,
		run,
		snapshot,
	};
};

test("retrying a failed attempt drops its completed Tool Call results from the next request", async () => {
	const { fixture, host, requests, run, snapshot } =
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

		const retry = await run({
			messageId: userMessageId,
			userText: "Read the file",
		});
		expect(retry).toMatchObject({ rejected: false });

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
		await host().shutdown();
		await fs.rm(fixture, { force: true });
	}
}, 30_000);

test("a failed attempt stays omitted after reopening the Session", async () => {
	const { fixture, host, reopen, requests, run, snapshot } =
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
		await host().shutdown();
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
		await fs.rm(fixture, { force: true });
	}
}, 30_000);
