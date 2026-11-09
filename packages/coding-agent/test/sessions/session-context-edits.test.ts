import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SessionMessageId, toSubmissionId } from "@wincode/agent-core";
import type { ProviderChatRequest } from "@wincode/ai";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import {
	applySessionContextEdits,
	sessionContextEditSchema,
} from "@/modules/sessions/context-edits";
import { openSessionServices } from "@/modules/sessions/host/session-services";
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
import { resolveLocalSessionProjectionPath } from "@/modules/sessions/storage/path";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionId } from "@/shared/identifiers";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	type FakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	compactionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";
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

test("replacing checkpoint text leaves its Tool Call part unchanged", () => {
	const toolPart = {
		input: { path: "example.txt" },
		output: "Original tool output",
		state: "output-available" as const,
		toolCallId: toolCallId("mixed-checkpoint-tool-call"),
		type: "tool-read" as const,
	};
	const message: SessionMessage = {
		id: sessionMessageId("mixed-checkpoint-edit"),
		parts: [{ text: "Original checkpoint", type: "text" }, toolPart],
		role: "assistant",
	};
	const [edited] = applySessionContextEdits(
		[message],
		[
			sessionContextEditSchema.parse({
				operationId: "replace-mixed-checkpoint",
				targetId: message.id,
				replacement: { text: "Edited checkpoint" },
			}),
		]
	);
	expect(edited?.parts).toEqual([
		{ text: "Edited checkpoint", type: "text" },
		toolPart,
	]);
});

test("editing a failed Tool Call result preserves its failure status", () => {
	const message: SessionMessage = {
		id: sessionMessageId("failed-tool-output-edit"),
		parts: [
			{
				errorText: "Original tool failure",
				input: { path: "missing.txt" },
				state: "output-error",
				toolCallId: toolCallId("failed-tool-output-edit"),
				type: "tool-read",
			},
		],
		role: "assistant",
	};
	const [edited] = applySessionContextEdits(
		[message],
		[
			sessionContextEditSchema.parse({
				operationId: "replace-failed-tool-output",
				targetId: message.id,
				replacement: { text: "Edited failure text" },
			}),
		]
	);
	expect(edited?.parts[0]).toMatchObject({
		errorText: "Edited failure text",
		state: "output-error",
	});
});

test("an incomplete Tool Call cannot be context-edited", () => {
	const message: SessionMessage = {
		id: sessionMessageId("incomplete-tool-output-edit"),
		parts: [
			{
				input: { path: "example.txt" },
				state: "input-available",
				toolCallId: toolCallId("incomplete-tool-output-edit"),
				type: "tool-read",
			},
		],
		role: "assistant",
	};
	expect(() =>
		applySessionContextEdits(
			[message],
			[
				sessionContextEditSchema.parse({
					operationId: "edit-incomplete-tool-output",
					targetId: message.id,
					replacement: { text: "Do not apply" },
				}),
			]
		)
	).toThrow("Only completed Tool Call results can be context-edited.");
});

test("editing a denied Tool Call result preserves its denial status", () => {
	const message: SessionMessage = {
		id: sessionMessageId("denied-tool-output-edit"),
		parts: [
			{
				errorText: "Original denial",
				input: { path: "secret.txt" },
				state: "output-denied",
				toolCallId: toolCallId("denied-tool-output-edit"),
				type: "tool-read",
			},
		],
		role: "assistant",
	};
	const [edited] = applySessionContextEdits(
		[message],
		[
			sessionContextEditSchema.parse({
				operationId: "replace-denied-tool-output",
				targetId: message.id,
				replacement: { text: "Edited denial text" },
			}),
		]
	);
	expect(edited?.parts[0]).toMatchObject({
		errorText: "Edited denial text",
		state: "output-denied",
	});
});

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

test("a later turn keeps edited context out of the live transcript", async () => {
	const recorder = createFakeProviderRecorder();
	const { sdk } = await sdkIn("next-turn-transcript", recorder);
	const { handle, sessionId } = await openSession(sdk);
	try {
		await finishPrompt(handle, "Original question");
		await onceIdle(() =>
			handle.editContext({
				operationId: "edit-before-next-turn",
				targetId: firstUserMessageId(handle),
				replacement: { text: "Model-only replacement" },
			})
		);

		await finishPrompt(handle, "Follow-up question");

		expect(contextText(handle)).toContain("Model-only replacement");
		expect(transcriptText(handle)).toContain("Original question");
		expect(transcriptText(handle)).toContain("Follow-up question");
		expect(transcriptText(handle)).not.toContain("Model-only replacement");
		expect(await durableText(sdk, sessionId)).toContain("Original question");
		expect(await durableText(sdk, sessionId)).not.toContain(
			"Model-only replacement"
		);
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}
});

test("reopening an older SQLite projection replays persisted context edits", async () => {
	const { sdk, workspace } = await sdkIn("old-projection");
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
		await onceIdle(() =>
			handle.editContext({
				operationId: "old-projection-edit",
				targetId: firstUserMessageId(handle),
				replacement: { text: "Persisted replacement" },
			})
		);
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}

	const projectionDb = new Database(
		resolveLocalSessionProjectionPath(options.databasePath)
	);
	try {
		projectionDb.exec("DROP TABLE session_context_edit;");
	} finally {
		projectionDb.close();
	}

	const reopenedSdk = await createSessionSdkWithRuntime(options);
	const reopened = await reopenedSdk.openSession(sessionId, {
		autoContinue: false,
	});
	try {
		expect(contextText(reopened)).toContain("Persisted replacement");
		expect(transcriptText(reopened)).toContain("Original question");
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

test("retrying an edit succeeds after compaction removes its target", async () => {
	const workspace = path.join(root, "retry-compacted-target");
	await fs.mkdir(workspace);
	const openServices = () =>
		openSessionServices({
			policy: {
				cwd: workspace,
				databasePath: path.join(workspace, "sessions.sqlite"),
				workspace,
			},
			sources: {
				createProviderCollection: () =>
					createFakeProviderCollection(createFakeProviderRecorder()),
			},
		});
	const initialServices = await openServices();
	const created = await initialServices.store.createEmptySession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	const firstHandle = await initialServices.sessionSdk.openSession(created.id, {
		autoContinue: false,
	});
	let edit: Parameters<SessionSdkHandle["editContext"]>[0] | undefined;
	let targetId: SessionMessageId | undefined;
	let firstKeptId: SessionMessageId | undefined;
	try {
		await finishPrompt(firstHandle, "Original question");
		await finishPrompt(firstHandle, "Question retained after compaction");
		const users = transcriptMessages(firstHandle).filter(
			({ role }) => role === "user"
		);
		const original = users[0];
		const retained = users[1];
		if (original === undefined || retained === undefined) {
			throw new Error("The compaction fixture is missing user messages.");
		}
		targetId = original.id;
		firstKeptId = retained.id;
		const contextEdit = {
			operationId: "retry-after-compaction",
			targetId,
			replacement: { text: "Original question made shorter" },
		};
		edit = contextEdit;
		await onceIdle(() => firstHandle.editContext(contextEdit));
	} finally {
		await firstHandle.dispose();
		await initialServices.shutdown();
	}
	if (
		edit === undefined ||
		targetId === undefined ||
		firstKeptId === undefined
	) {
		throw new Error("The context edit fixture was not created.");
	}

	const compactionServices = await openServices();
	try {
		const compaction = await compactionServices.store.appendCompaction({
			estimatedTokensAfter: 20,
			firstKeptUiMessageId: firstKeptId,
			id: compactionId("retry-context-edit-compaction"),
			sessionId: created.id,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				attachments: [],
				coveredMessageIds: [targetId],
				formatVersion: 1,
				text: "The original question is summarized.",
			},
			throughMessageUiId: targetId,
			tokensBefore: 80,
			trigger: "threshold",
		});
		if (compaction.writeOutcome.kind !== "committed") {
			throw new Error("The compaction fixture was not committed.");
		}
		const reopened = await compactionServices.sessionSdk.openSession(
			created.id,
			{
				autoContinue: false,
			}
		);
		try {
			await expect(reopened.editContext(edit)).resolves.toBeUndefined();
			expect(transcriptText(reopened)).toContain("Original question");
			expect(contextText(reopened)).toContain(
				"Question retained after compaction"
			);
		} finally {
			await reopened.dispose();
		}
	} finally {
		await compactionServices.shutdown();
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

test("tool edits survive reopen without changing call identity, checkpoint text, or history", async () => {
	const temporaryRoot = path.join(process.cwd(), ".tmp");
	await fs.mkdir(temporaryRoot, { recursive: true });
	const fixture = await fs.mkdtemp(
		path.join(temporaryRoot, "context-edit-tool-")
	);
	const file = path.join(fixture, "example.txt");
	try {
		const recorder = createFakeProviderRecorder();
		const requests: ProviderChatRequest[] = [];
		recorder.stepScript = async function* (request) {
			requests.push(structuredClone(request));
			if (requests.length === 1) {
				yield { delta: "Checkpoint before tool", type: "text-delta" };
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
		const { sdk, workspace } = await sdkIn("tool", recorder);
		await Bun.write(file, "Original tool output");
		const { handle, sessionId } = await openSession(sdk);
		try {
			await finishPrompt(handle, "Read example.txt");
			const history = await sdk.readSessionHistoryPage(sessionId);
			const tool = history.records.find(
				(record) => record.outcome.kind === "tool"
			);
			const checkpoint = history.records
				.filter((record) => record.outcome.kind === "checkpoint")
				.flatMap((record) => record.messages)
				.find((message) => message.parts.some((part) => part.type === "text"));
			expect(tool?.messages[0]?.parts[0]).toMatchObject({
				outcome: { kind: "success" },
			});
			const toolTargetId = tool?.messages[0]?.id;
			if (toolTargetId === undefined || checkpoint === undefined) {
				throw new Error("Missing completed Tool Call checkpoint.");
			}
			await onceIdle(() =>
				handle.editContext({
					operationId: "omit-read-output",
					targetId: toolTargetId,
					replacement: null,
				})
			);
			const editedToolMessage = contextMessages(handle).find(
				(message) => message.id === toolTargetId
			);
			expect(editedToolMessage?.parts[0]).toMatchObject({ output: "" });
			await finishPrompt(handle, "Check the omitted tool output");
			const omittedParts =
				requests.at(-1)?.messages.flatMap((message) => message.content) ?? [];
			expect(omittedParts).toContainEqual(
				expect.objectContaining({
					input: { path: file },
					toolCallId: "context-edit-read",
					type: "tool-call",
				})
			);
			expect(omittedParts).toContainEqual(
				expect.objectContaining({
					output: "",
					toolCallId: "context-edit-read",
					type: "tool-result",
				})
			);
			await onceIdle(() =>
				handle.editContext({
					operationId: "shorten-read",
					targetId: toolTargetId,
					replacement: { text: "Short tool output" },
				})
			);
			await onceIdle(() =>
				handle.editContext({
					operationId: "replace-checkpoint-text",
					targetId: checkpoint.id,
					replacement: { text: "Edited checkpoint text" },
				})
			);
			expect(await durableText(sdk, sessionId)).toContain(
				"Original tool output"
			);
			await handle.dispose();
			await sdk.dispose();

			const reopenedSdk = await createSessionSdkWithRuntime({
				createProviderCollection: () => createFakeProviderCollection(recorder),
				cwd: workspace,
				databasePath: path.join(workspace, "sessions.sqlite"),
				pluginPaths: [],
				workspace,
			});
			const reopened = await reopenedSdk.openSession(sessionId, {
				autoContinue: false,
			});
			try {
				await finishPrompt(reopened, "Use the shortened result");
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
				expect(parts).toContainEqual(
					expect.objectContaining({
						text: "Edited checkpoint text",
						type: "text",
					})
				);
				expect(await durableText(reopenedSdk, sessionId)).toContain(
					"Original tool output"
				);
			} finally {
				await reopened.dispose();
				await reopenedSdk.dispose();
			}
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

test("a pending steering message makes context edits busy", async () => {
	const workspace = path.join(root, "pending-steering");
	await fs.mkdir(workspace);
	const services = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "sessions.sqlite"),
			workspace,
		},
		sources: {
			createProviderCollection: () =>
				createFakeProviderCollection(createFakeProviderRecorder()),
		},
	});
	const created = await services.store.createEmptySession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	const activeMessageId = sessionMessageId("active-before-steering");
	await services.store.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: activeMessageId,
				metadata: { model: DEFAULT_PROVIDER_MODEL_SELECTION },
				parts: [{ text: "Active user input", type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("active-user-turn"),
		}),
		sessionId: created.id,
	});
	const messageId = sessionMessageId("pending-steering-message");
	const submissionRecord = buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			id: messageId,
			metadata: {
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				submissionId: toSubmissionId("pending-steering-submission"),
				submissionStatus: "pending",
			},
			parts: [{ text: "Pending steering input", type: "text" }],
			role: "user",
		},
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("pending-steering-turn"),
	});
	await services.store.commitSessionRecord({
		record: submissionRecord,
		sessionId: created.id,
	});
	const handle = await services.sessionSdk.openSession(created.id, {
		autoContinue: false,
	});
	try {
		await expect(
			handle.editContext({
				operationId: "edit-while-steering-pending",
				targetId: activeMessageId,
				replacement: null,
			})
		).rejects.toMatchObject({ code: "session_busy" });
	} finally {
		await handle.dispose();
		await services.shutdown();
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

test("a failed attempt is omitted from the next provider request but stays in history", async () => {
	const recorder = createFakeProviderRecorder();
	let providerDown = true;
	recorder.beforeChat = async () => {
		if (!providerDown) {
			return;
		}
		providerDown = false;
		throw new Error("Provider is unavailable");
	};
	const { sdk } = await sdkIn("failed-attempt", recorder);
	const { handle, sessionId } = await openSession(sdk);
	try {
		await finishPrompt(handle, "First attempt");
		await finishPrompt(handle, "Second attempt");
		const request = recorder.requests.at(-1);
		if (request?.kind !== "chat") {
			throw new Error("Missing provider request.");
		}
		expect(
			request.messages.some((message) =>
				message.text.includes("The Agent Turn failed")
			)
		).toBe(false);
		expect(
			request.messages.some((message) => message.text.includes("First attempt"))
		).toBe(true);
		expect(transcriptText(handle)).toContain("First attempt");
		expect(await durableText(sdk, sessionId)).toContain("First attempt");
	} finally {
		await handle.dispose();
		await sdk.dispose();
	}
});
