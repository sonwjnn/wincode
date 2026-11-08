import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMessageId } from "@wincode/agent-core";
import type { ProviderChatRequest } from "@wincode/ai";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import {
	isSessionToolPart,
	type SessionMessage,
} from "@/modules/sessions/message";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdk,
	SessionSdkHandle,
	SessionSdkSnapshot,
} from "@/modules/sessions/sdk-contract";
import type { SessionId } from "@/shared/identifiers";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	type FakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { sessionMessageId } from "../support/identifiers";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-context-edits-"));
afterAll(() => removeTemporaryDirectory(root));

const sdkIn = async (
	name: string,
	recorder: FakeProviderRecorder = createFakeProviderRecorder()
): Promise<{ sdk: SessionSdk; workspace: string }> => {
	const workspace = path.join(root, name);
	await fs.mkdir(workspace);
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		databasePath: path.join(workspace, "sessions.sqlite"),
		pluginPaths: [],
		workspace,
	});
	return { sdk, workspace };
};

const openSession = async (
	sdk: SessionSdk
): Promise<{ handle: SessionSdkHandle; sessionId: SessionId }> => {
	const sessionId = await sdk.createEmptySession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	return {
		handle: await sdk.openSession(sessionId, { autoContinue: false }),
		sessionId,
	};
};

const snapshotOf = (handle: SessionSdkHandle): SessionSdkSnapshot => {
	let current: SessionSdkSnapshot | undefined;
	const unsubscribe = handle.subscribe((snapshot) => {
		current = snapshot;
	});
	unsubscribe();
	if (current === undefined) {
		throw new Error("The Session did not publish its snapshot.");
	}
	return current;
};

const finishPrompt = async (
	handle: SessionSdkHandle,
	text: string
): Promise<void> => {
	const terminal = Promise.withResolvers<void>();
	const unsubscribe = handle.onEvent((event) => {
		if (
			event.type === "agent-turn-completed" ||
			event.type === "agent-turn-failed"
		) {
			terminal.resolve();
		}
	});
	try {
		expect(
			(await handle.deliver({ idempotencyKey: crypto.randomUUID(), text }))
				.rejected
		).toBe(false);
		await terminal.promise;
	} finally {
		unsubscribe();
	}
};

const isSessionBusy = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	Reflect.get(error, "code") === "session_busy";

/**
 * The Host announces a terminal Agent Turn before it releases the execution its
 * idle gate checks, so an idle-only command issued on that event can still see
 * the Session as busy. Retry only that transient rejection.
 */
const onceIdle = async <Result>(
	action: () => Promise<Result>
): Promise<Result> => {
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			return await action();
		} catch (error) {
			if (!(isSessionBusy(error) && Date.now() < deadline)) {
				throw error;
			}
			await Bun.sleep(1);
		}
	}
};

const messageText = (message: SessionMessage): string =>
	message.parts
		.flatMap((part) => {
			if (part.type === "text") {
				return [part.text];
			}
			if (!isSessionToolPart(part)) {
				return [];
			}
			if (part.state === "output-available") {
				return [
					typeof part.output === "string"
						? part.output
						: JSON.stringify(part.output),
				];
			}
			return part.state === "output-error" ? [part.errorText] : [];
		})
		.join("\n");

const contextMessages = (handle: SessionSdkHandle): readonly SessionMessage[] =>
	snapshotOf(handle).context as readonly SessionMessage[];

const transcriptMessages = (
	handle: SessionSdkHandle
): readonly SessionMessage[] =>
	snapshotOf(handle).transcript as readonly SessionMessage[];

const contextText = (handle: SessionSdkHandle): string =>
	contextMessages(handle).map(messageText).join("\n");

const transcriptText = (handle: SessionSdkHandle): string =>
	transcriptMessages(handle).map(messageText).join("\n");

const durableText = async (
	sdk: SessionSdk,
	sessionId: SessionId
): Promise<string> =>
	JSON.stringify((await sdk.readSessionHistoryPage(sessionId)).records);

const firstUserMessageId = (handle: SessionSdkHandle): SessionMessageId => {
	const target = contextMessages(handle)[0];
	if (target === undefined) {
		throw new Error("The Session has no user message.");
	}
	return target.id;
};

test("SDK context replacement survives reopen without rewriting the original transcript", async () => {
	const { sdk, workspace } = await sdkIn("replace");
	const options = {
		createProviderCollection: () =>
			createFakeProviderCollection(createFakeProviderRecorder()),
		cwd: workspace,
		databasePath: path.join(workspace, "sessions.sqlite"),
		pluginPaths: [],
		workspace,
	};
	const { handle, sessionId } = await openSession(sdk);
	try {
		await finishPrompt(handle, "Original question");
		const before = snapshotOf(handle).transcript;
		const targetId = firstUserMessageId(handle);
		await onceIdle(() =>
			handle.editContext({
				operationId: "replace-question",
				targetId,
				replacement: { text: "Short question" },
			})
		);
		expect(snapshotOf(handle).transcript).toEqual(before);
		expect(contextMessages(handle)[0]?.parts).toEqual([
			{ text: "Short question", type: "text" },
		]);
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}

	const reopenedSdk = await createSessionSdkWithRuntime(options);
	const reopened = await reopenedSdk.openSession(sessionId, {
		autoContinue: false,
	});
	try {
		expect(contextText(reopened)).toContain("Short question");
		expect(transcriptText(reopened)).toContain("Original question");
		expect(transcriptText(reopened)).not.toContain("Short question");
	} finally {
		await reopened.dispose();
		await reopenedSdk.dispose();
	}
});

test("an edit that names no active durable message is rejected before any write", async () => {
	const { sdk } = await sdkIn("missing-target");
	const { handle, sessionId } = await openSession(sdk);
	try {
		await finishPrompt(handle, "Keep this message");
		await expect(
			onceIdle(() =>
				handle.editContext({
					operationId: "missing-target",
					targetId: sessionMessageId("missing-message"),
					replacement: null,
				})
			)
		).rejects.toThrow("active durable message");
		expect(contextText(handle)).toContain("Keep this message");
		expect(await durableText(sdk, sessionId)).not.toContain("missing-target");
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}
});

test("retrying an earlier edit does not override a later committed replacement", async () => {
	const { sdk } = await sdkIn("retry");
	const { handle, sessionId } = await openSession(sdk);
	try {
		await finishPrompt(handle, "Original content");
		const targetId = firstUserMessageId(handle);
		const first = {
			operationId: "edit-first",
			targetId,
			replacement: { text: "First replacement" },
		};
		await onceIdle(() => handle.editContext(first));
		await onceIdle(() =>
			handle.editContext({
				operationId: "edit-second",
				targetId,
				replacement: { text: "Latest replacement" },
			})
		);
		await onceIdle(() => handle.editContext(first));
		expect(contextText(handle)).toContain("Latest replacement");
		expect(contextText(handle)).not.toContain("First replacement");
		await expect(
			onceIdle(() =>
				handle.editContext({
					...first,
					replacement: { text: "Conflicting payload" },
				})
			)
		).rejects.toThrow();
		expect(contextText(handle)).toContain("Latest replacement");
		expect(await durableText(sdk, sessionId)).toContain("Original content");
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}
});

test("an omitted message is absent from the next provider request while history keeps it", async () => {
	const recorder = createFakeProviderRecorder();
	const { sdk } = await sdkIn("omit", recorder);
	const { handle, sessionId } = await openSession(sdk);
	try {
		await finishPrompt(handle, "Discard this old question");
		await onceIdle(() =>
			handle.editContext({
				operationId: "omit-question",
				targetId: firstUserMessageId(handle),
				replacement: null,
			})
		);
		await finishPrompt(handle, "A new question");
		const request = recorder.requests.at(-1);
		expect(request?.kind).toBe("chat");
		if (request?.kind !== "chat") {
			throw new Error("Missing provider request.");
		}
		expect(
			request.messages.some((message) =>
				message.text.includes("Discard this old question")
			)
		).toBe(false);
		expect(
			request.messages.some((message) =>
				message.text.includes("A new question")
			)
		).toBe(true);
		expect(await durableText(sdk, sessionId)).toContain(
			"Discard this old question"
		);
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}
});

test("tool output edits keep call identity and input intact in subsequent provider requests", async () => {
	const fixture = await fs.mkdtemp(
		path.join(process.cwd(), ".context-edit-tool-")
	);
	const file = path.join(fixture, "example.txt");
	await Bun.write(file, "Original tool output");
	try {
		const recorder = createFakeProviderRecorder();
		const requests: ProviderChatRequest[] = [];
		recorder.stepScript = async function* (request) {
			requests.push(request);
			if (requests.length === 1) {
				yield {
					input: { path: file },
					toolCallId: "context-edit-read",
					toolName: "read",
					type: "tool-call",
				};
			} else {
				yield { delta: "Read complete", type: "text-delta" };
			}
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
		};
		const { sdk } = await sdkIn("tool", recorder);
		const { handle, sessionId } = await openSession(sdk);
		try {
			await finishPrompt(handle, "Read example.txt");
			const history = await sdk.readSessionHistoryPage(sessionId);
			const tool = history.records.find(
				(record) => record.outcome.kind === "tool"
			);
			expect(tool?.messages[0]?.parts[0]).toMatchObject({
				outcome: { kind: "success" },
			});
			const targetId = tool?.messages[0]?.id;
			if (targetId === undefined) {
				throw new Error("Missing completed Tool Call.");
			}
			await onceIdle(() =>
				handle.editContext({
					operationId: "shorten-read",
					targetId,
					replacement: { text: "Short tool output" },
				})
			);
			await finishPrompt(handle, "Use the shortened result");
			const parts =
				requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
			expect(parts).toContainEqual(
				expect.objectContaining({
					input: { path: file },
					toolCallId: "context-edit-read",
					type: "tool-call",
				})
			);
			expect(parts).toContainEqual(
				expect.objectContaining({
					output: "Short tool output",
					toolCallId: "context-edit-read",
					type: "tool-result",
				})
			);
			expect(await durableText(sdk, sessionId)).toContain(
				"Original tool output"
			);
		} finally {
			await handle.dispose();
			await sdk.dispose();
		}
	} finally {
		await removeTemporaryDirectory(fixture);
	}
});

test("editing a busy Session rejects without changing its accepted user content", async () => {
	const recorder = createFakeProviderRecorder();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	recorder.beforeChat = async () => {
		entered.resolve();
		await release.promise;
	};
	const { sdk } = await sdkIn("busy", recorder);
	const { handle } = await openSession(sdk);
	try {
		const finished = finishPrompt(handle, "Keep this accepted question");
		await entered.promise;
		await expect(
			handle.editContext({
				operationId: "busy-edit",
				targetId: firstUserMessageId(handle),
				replacement: null,
			})
		).rejects.toMatchObject({ code: "session_busy" });
		release.resolve();
		await finished;
		expect(contextText(handle)).toContain("Keep this accepted question");
	} finally {
		release.resolve();
		await handle.dispose();
		await sdk.dispose();
	}
});

test("a fork remaps edits in its checkpoint prefix and exports them independently of its source", async () => {
	const { sdk, workspace } = await sdkIn("fork");
	const { handle, sessionId } = await openSession(sdk);
	let forkHandle: SessionSdkHandle | undefined;
	try {
		await finishPrompt(handle, "Original source text");
		await onceIdle(() =>
			handle.editContext({
				operationId: "fork-prefix-edit",
				targetId: firstUserMessageId(handle),
				replacement: { text: "Portable replacement" },
			})
		);
		await finishPrompt(handle, "Commit a later checkpoint");
		const checkpoint = (await sdk.readSessionHistoryPage(sessionId)).records.at(
			-1
		);
		if (checkpoint === undefined) {
			throw new Error("Missing fork checkpoint.");
		}
		const fork = await onceIdle(() =>
			handle.fork({ recordId: checkpoint.id }, "fork-edited-context")
		);
		forkHandle = fork.handle;
		expect(contextText(forkHandle)).toContain("Portable replacement");
		expect(transcriptText(forkHandle)).toContain("Original source text");

		const destination = path.join(workspace, "bundle");
		await sdk.exportSessionBundle(fork.id, destination);
		const { sdk: importedSdk } = await sdkIn("imported");
		try {
			const imported = await importedSdk.importSessionBundle(destination);
			const importedHandle = await importedSdk.openSession(imported.sessionId, {
				autoContinue: false,
			});
			try {
				expect(contextText(importedHandle)).toContain("Portable replacement");
				expect(transcriptText(importedHandle)).toContain(
					"Original source text"
				);
			} finally {
				await importedHandle.dispose();
			}
		} finally {
			await importedSdk.dispose();
		}
	} finally {
		await forkHandle?.dispose();
		await handle.dispose();
		await sdk.dispose();
	}
});
