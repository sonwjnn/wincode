import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
	type ProviderCollection,
	ProviderError,
	type ProviderModel,
} from "@wincode/ai";
import { buildAgentRegistry } from "../modules/agents/registry";
import { runRpc } from "../modules/application/rpc/runner";
import {
	createPluginRuntime,
	type PluginProviderDescriptor,
} from "../modules/plugins/runtime";
import { pluginProviderStorageId } from "../modules/providers/provider-stores";
import { createDefaultSessionProviderCollection } from "../modules/sessions/provider-collection";
import { SessionWriterLockFailureError } from "../modules/sessions/storage/session-writer-lock";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "./support/identifiers";

const workspace = await fs.mkdtemp(path.join("/tmp", "wincode-rpc-journey-"));
const commandDirectory = path.join(workspace, ".wincode", "commands");
await fs.mkdir(commandDirectory, { recursive: true });
await Bun.write(
	path.join(commandDirectory, "review.md"),
	"---\ndescription: Review API changes\n---\nInspect only $ARGUMENTS."
);
const databasePath = path.join(workspace, "conversation.sqlite");

import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	installFakeProviderRecorder,
} from "./support/e2e-fake-runtime";

const recorder = createFakeProviderRecorder();
const rpcProviderModel: ProviderModel = {
	capabilities: ["reasoning", "text", "tools"],
	modelId: "gpt-5.6-luna",
	protocolId: "fake-e2e-provider",
	providerId: "openai",
	reasoningEfforts: ["high"],
};
installFakeProviderRecorder(recorder);

import { openSessionServices } from "../modules/sessions/host/session-services";
import { createDatabase } from "../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../modules/sessions/storage/drizzle-session-store";
import type { ConfigSnapshot } from "../shared/config/config-store";

afterAll(async () => {
	mock.restore();
	await fs.rm(workspace, { force: true, recursive: true });
});

test("raw JSONL drives a real Session Host through persistence", async () => {
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const stdout = {
		frames: stdoutFrames,
		write: (text: string): undefined => {
			stdoutFrames.push(text);
		},
	};
	const stderr = {
		frames: stderrFrames,
		write: (text: string): undefined => {
			stderrFrames.push(text);
		},
	};
	const initialized = Promise.withResolvers<void>();
	const invalidSelectionRejected = Promise.withResolvers<void>();
	const transcriptReady = Promise.withResolvers<void>();
	const modelStepStarted = Promise.withResolvers<void>();
	const releaseModelStep = Promise.withResolvers<void>();
	const secondModelStepStarted = Promise.withResolvers<void>();
	const releaseSecondModelStep = Promise.withResolvers<void>();
	const queuedSubmitAccepted = Promise.withResolvers<void>();
	const steeringAccepted = Promise.withResolvers<void>();
	let modelStepCount = 0;
	let secondModelStepReleased = false;
	recorder.beforeChat = async () => {
		modelStepCount += 1;
		if (modelStepCount === 1) {
			modelStepStarted.resolve();
			await releaseModelStep.promise;
		} else if (modelStepCount === 2) {
			secondModelStepStarted.resolve();
			await releaseSecondModelStep.promise;
		}
	};
	const assembly = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () =>
				createFakeProviderCollection(recorder, rpcProviderModel),
		},
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const initialize = `${request("initialize", "initialize", {
		capabilities: {},
		clientInfo: { name: "journey-test" },
		cwd: workspace,
		protocolVersion: 4,
	})}\n`;
	const create = `${request("create", "session/create", {
		initialSubmission: {
			composition: {
				pastedText: [{ text: "API handlers", token: "[Pasted ~2 lines]" }],
				text: "[Pasted ~2 lines]",
			},
			intent: { kind: "custom", name: "review" },
		},
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			thinkingLevel: "high",
		},
	})}\n`;
	const invalidCreate = `${request("invalid-create", "session/create", {
		initialSubmission: { text: "reject invalid ThinkingLevel" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			thinkingLevel: "not-a-level",
		},
	})}\n`;
	const legacyCreate = `${request("legacy-create", "session/create", {
		initialSubmission: { text: "reject legacy reasoningMode" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			reasoningMode: "none",
		},
	})}\n`;
	const queuedSubmit = `${request("queued-submit", "session/submit", {
		submission: {
			intent: { kind: "custom", name: "review" },
			text: "resource boundaries",
		},
	})}\n`;
	const steerQueued = `${request("steer-queued", "session/steer", {})}\n`;
	const transcript = `${request("transcript", "session/getTranscript", {})}\n`;
	const shutdown = `${request("shutdown", "server/shutdown", {})}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(initialize);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${invalidCreate}${legacyCreate}${create.slice(0, 11)}`
		);
		await invalidSelectionRejected.promise;
		yield new TextEncoder().encode(create.slice(11));
		await modelStepStarted.promise;
		yield new TextEncoder().encode(queuedSubmit);
		await queuedSubmitAccepted.promise;
		yield new TextEncoder().encode(steerQueued);
		await steeringAccepted.promise;
		releaseModelStep.resolve();
		await secondModelStepStarted.promise;
		secondModelStepReleased = true;
		releaseSecondModelStep.resolve();
		await transcriptReady.promise;
		yield new TextEncoder().encode(transcript + shutdown);
	})();
	stdout.write = (text: string): undefined => {
		const frame = JSON.parse(text) as {
			id?: string;
			method?: string;
			params?: {
				state?: {
					status?: string;
					transcript?: { messageCount?: number };
				};
			};
		};
		stdoutFrames.push(text);
		if (frame.id === "initialize") {
			initialized.resolve();
		}
		if (frame.id === "invalid-create") {
			invalidSelectionRejected.resolve();
		}
		if (frame.id === "queued-submit") {
			queuedSubmitAccepted.resolve();
		}
		if (frame.id === "steer-queued") {
			steeringAccepted.resolve();
		}
		if (
			modelStepCount >= 2 &&
			secondModelStepReleased &&
			frame.method === "session/stateChanged" &&
			frame.params?.state?.status === "idle"
		) {
			transcriptReady.resolve();
		}
	};
	const exitCode = await runRpc({
		composeServices: async () => assembly,
		input,
		stderr,
		stdout,
	});
	const frames = stdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	const createIndex = frames.findIndex((frame) => frame.id === "create");
	const firstEventIndex = frames.findIndex(
		(frame) => frame.method === "session/event"
	);
	const invalidSelectionFrame = frames.find(
		(frame) => frame.id === "invalid-create"
	);
	expect(invalidSelectionFrame?.error).toMatchObject({
		data: { code: "selection_unavailable" },
	});
	const legacySelectionFrame = frames.find(
		(frame) => frame.id === "legacy-create"
	);
	expect(legacySelectionFrame?.error).toMatchObject({
		data: { code: "selection_unavailable" },
	});
	expect(exitCode).toBe(0);
	expect(stderrFrames).toEqual([]);
	expect(createIndex).toBeGreaterThanOrEqual(0);
	expect(firstEventIndex).toBeGreaterThan(createIndex);
	const queuedSubmitFrame = frames.find(
		(frame) => frame.id === "queued-submit"
	);
	expect(queuedSubmitFrame?.result).toMatchObject({
		disposition: "queued",
		rejected: false,
	});
	const steerFrame = frames.find((frame) => frame.id === "steer-queued");
	expect(steerFrame?.result).toMatchObject({ kind: "steered" });
	expect(frames.some((frame) => frame.id === "transcript")).toBe(true);
	expect(frames.some((frame) => frame.id === "shutdown")).toBe(true);
	const chatRequests = recorder.requests.filter(
		(entry) => entry.kind === "chat"
	);
	expect(
		chatRequests.some((entry) =>
			JSON.stringify(entry).includes("Inspect only API handlers.")
		)
	).toBe(true);
	expect(
		chatRequests.some((entry) =>
			JSON.stringify(entry).includes("Inspect only resource boundaries.")
		)
	).toBe(true);
	const createFrame = frames[createIndex];
	const createResult = createFrame?.result;
	const sessionId =
		typeof createResult === "object" &&
		createResult !== null &&
		"sessionId" in createResult &&
		typeof createResult.sessionId === "string"
			? createResult.sessionId
			: undefined;
	expect(sessionId).toBeString();
	if (sessionId === undefined) {
		throw new Error("The RPC journey did not return a Session ID.");
	}
	const secondAssembly = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () =>
				createFakeProviderCollection(recorder, rpcProviderModel),
		},
	});
	const secondStdoutFrames: string[] = [];
	const secondStderrFrames: string[] = [];
	const secondExitCode = await runRpc({
		composeServices: async () => secondAssembly,
		input: [
			new TextEncoder().encode(
				`${request("reinitialize", "initialize", {
					capabilities: {},
					clientInfo: { name: "reopen-test" },
					cwd: workspace,
					protocolVersion: 4,
				})}\n`
			),
			new TextEncoder().encode(
				`${request("open", "session/open", { sessionId })}\n`
			),
			new TextEncoder().encode(
				`${request("reopen-transcript", "session/getTranscript", {})}\n`
			),
			new TextEncoder().encode(
				`${request("reopen-shutdown", "server/shutdown", {})}\n`
			),
		],
		stderr: {
			write: (text: string): undefined => {
				secondStderrFrames.push(text);
			},
		},
		stdout: {
			write: (text: string): undefined => {
				secondStdoutFrames.push(text);
			},
		},
	});
	const secondFrames = secondStdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	const openFrame = secondFrames.find((frame) => frame.id === "open");
	const openResult = openFrame?.result;
	const openState =
		typeof openResult === "object" &&
		openResult !== null &&
		"state" in openResult &&
		typeof openResult.state === "object" &&
		openResult.state !== null
			? openResult.state
			: undefined;
	expect(secondExitCode).toBe(0);
	expect(secondStderrFrames).toEqual([]);
	expect(openState).toBeDefined();
	expect(openState).toMatchObject({ selection: { thinkingLevel: "high" } });
	expect(secondFrames.some((frame) => frame.id === "reopen-transcript")).toBe(
		true
	);
	const reopenTranscriptFrame = secondFrames.find(
		(frame) => frame.id === "reopen-transcript"
	);
	const reopenTranscriptResult = reopenTranscriptFrame?.result;
	const reopenMessages =
		typeof reopenTranscriptResult === "object" &&
		reopenTranscriptResult !== null &&
		"messages" in reopenTranscriptResult &&
		Array.isArray(reopenTranscriptResult.messages)
			? reopenTranscriptResult.messages
			: undefined;
	expect(reopenMessages).toBeDefined();
	if (reopenMessages === undefined) {
		throw new Error("The reopened RPC journey did not return a transcript.");
	}
	expect(JSON.stringify(reopenMessages)).toContain(
		"Inspect only resource boundaries."
	);
	expect(reopenMessages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				metadata: expect.objectContaining({ thinkingLevel: "high" }),
			}),
		])
	);
	const reopened = createDatabase(databasePath);
	const store = createDrizzleSessionStore(reopened.db, {
		workspaceRoot: workspace,
	});
	const sessions = await store.listSessions();
	expect(sessions).toHaveLength(1);
	const session = sessions[0];
	if (session === undefined) {
		throw new Error("The RPC journey did not persist a Session.");
	}
	const records = await store.listSessionRecords(session.id);
	expect(records.some((record) => record.outcome.kind === "user")).toBe(true);
	expect(records.map((record) => record.outcome.kind)).toContain("assistant");
	expect(
		records.some(
			(record) =>
				record.outcome.kind === "user" && record.model.thinkingLevel === "high"
		)
	).toBe(true);
	const assistantRecord = records.find(
		(record) => record.outcome.kind === "assistant"
	);
	expect(assistantRecord?.model.thinkingLevel).toBe("high");
	expect(
		assistantRecord?.messages.some(
			(message) => message.metadata?.thinkingLevel === "high"
		)
	).toBe(true);
	expect(session.thinkingLevel).toBe("high");
});

test("RPC runs an explicitly selected Plugin Provider and emits a secret-free authentication failure", async () => {
	const authWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-plugin-auth-")
	);
	const fakeSecret = "rpc-fake-plugin-credential-do-not-project";
	const credentialReads = new Set<string>();
	const providerModel: ProviderModel = {
		capabilities: ["text", "tools"],
		limits: { maxOutputTokens: 128 },
		modelId: "auth-model-v1",
		protocolId: "fake-plugin-auth",
		providerId: "fake-plugin-auth",
	};
	const provider: Provider = {
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: () => {
			throw new ProviderError("authentication", fakeSecret);
		},
		async *streamChat() {
			yield { type: "finish" };
		},
	};
	const pluginId = "rpc-plugin-auth";
	const sourceIdentity = path.join(authWorkspace, "rpc-plugin-auth.ts");
	const providerStorageId = pluginProviderStorageId({
		pluginId,
		providerId: providerModel.providerId,
		sourceIdentity,
	});
	const registration: PluginProviderDescriptor = {
		connect: async () => undefined,
		createProvider: () => provider,
		displayName: "RPC fake authentication Provider",
		pluginId,
		providerId: providerModel.providerId,
		sourceIdentity,
		sourcePath: sourceIdentity,
	};
	const pluginRuntime = createPluginRuntime(
		[
			{
				commands: [],
				id: pluginId,
				providers: [registration],
				sourcePath: sourceIdentity,
				tools: [],
				workspace: authWorkspace,
			},
		],
		[]
	);
	const agentRegistry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const legacyProviderChecks = 0;
	const assembly = await openSessionServices({
		policy: {
			cwd: authWorkspace,
			databasePath: path.join(authWorkspace, "sessions.sqlite"),
			workspace: authWorkspace,
		},
		sources: {
			createProviderCollection: (
				currentPluginRuntime,
				sessionId,
				allowedPluginProviderIds,
				allowedPluginProviderSources
			) =>
				createDefaultSessionProviderCollection(
					currentPluginRuntime,
					sessionId,
					{
						allowedPluginProviderIds,
						allowedPluginProviderSources,
						credentialStore: {
							delete: () => undefined,
							get: (providerId) => {
								credentialReads.add(providerId);
								return providerId === providerStorageId
									? fakeSecret
									: undefined;
							},
							set: () => undefined,
						},
					}
				),
			pluginRuntime: () => pluginRuntime,
			registry: () => agentRegistry,
		},
	});
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const initialized = Promise.withResolvers<void>();
	const created = Promise.withResolvers<Record<string, unknown>>();
	const failed = Promise.withResolvers<Record<string, unknown>>();
	let failureEvent: Record<string, unknown> | undefined;
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = {
		write: (text: string): undefined => {
			stdoutFrames.push(text);
			const frame = JSON.parse(text) as Record<string, unknown>;
			if (frame.id === "initialize") {
				initialized.resolve();
			}
			if (frame.id === "create") {
				created.resolve(frame);
			}
			if (frame.method !== "session/event") {
				return;
			}
			const params = frame.params as Record<string, unknown> | undefined;
			const wrapper = params?.event as Record<string, unknown> | undefined;
			const event = wrapper?.event as Record<string, unknown> | undefined;
			if (event?.type === "agent-turn-failed") {
				failureEvent = event;
				failed.resolve(event);
			}
		},
	};
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "plugin-auth-test" },
				cwd: authWorkspace,
				protocolVersion: 4,
			})}\n`
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${request("create", "session/create", {
				initialSubmission: {
					text: "Send with a fake selected Plugin Provider.",
				},
				selection: {
					agentId: "build",
					model: {
						modelId: providerModel.modelId,
						providerId: providerModel.providerId,
					},
				},
			})}\n`
		);
		const createFrame = await created.promise;
		if (createFrame.error === undefined) {
			await Promise.race([failed.promise, Bun.sleep(2000)]);
		}
		yield new TextEncoder().encode(
			`${request("shutdown", "server/shutdown", {})}\n`
		);
	})();
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout,
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(exitCode).toBe(0);
		expect(createFrame?.error).toBeUndefined();
		expect(legacyProviderChecks).toBe(0);
		expect(failureEvent).toMatchObject({
			type: "agent-turn-failed",
			failure: {
				code: "authentication",
				details: {
					modelId: providerModel.modelId,
					providerId: providerModel.providerId,
				},
				message: "Model authentication failed.",
			},
		});
		expect([...credentialReads]).toEqual([providerStorageId]);
		expect(stdoutFrames.join("") + stderrFrames.join("")).not.toContain(
			fakeSecret
		);
		expect(stderrFrames).toEqual([]);
	} finally {
		await Promise.all([assembly.shutdown(), pluginRuntime.shutdown()]);
		await fs.rm(authWorkspace, { force: true, recursive: true });
	}
});

test("RPC rejects an unavailable Provider Model before persisting submission messages or attachments", async () => {
	const rpcWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-unavailable-model-")
	);
	const activity = { availabilityCalls: 0, externalizations: 0 };
	const databasePath = path.join(rpcWorkspace, "sessions.sqlite");
	const knownModel: ProviderModel = {
		...rpcProviderModel,
		modelId: "another-known-model",
	};
	const assembly = await openSessionServices({
		policy: {
			cwd: rpcWorkspace,
			databasePath,
			workspace: rpcWorkspace,
		},
		sources: {
			createProviderCollection: () => {
				const collection = createFakeProviderCollection(recorder, knownModel);
				const getAvailable = collection.getAvailable.bind(collection);
				return {
					...collection,
					getAvailable: async () => {
						activity.availabilityCalls += 1;
						return getAvailable();
					},
				};
			},
		},
	});
	const originalExternalizeAttachments =
		assembly.store.externalizeAttachments.bind(assembly.store);
	assembly.store.externalizeAttachments = async (...args) => {
		activity.externalizations += 1;
		return originalExternalizeAttachments(...args);
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input: [
				new TextEncoder().encode(
					`${request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "unavailable-model-preflight" },
						cwd: rpcWorkspace,
						protocolVersion: 4,
					})}\n`
				),
				new TextEncoder().encode(
					`${request("create", "session/create", {
						initialSubmission: {
							files: [
								{
									content: {
										data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
										encoding: "base64",
									},
									filename: "proof.png",
									mediaType: "image/png",
								},
							],
							text: "Reject before persisting this attachment.",
						},
						selection: {
							agentId: "build",
							model: {
								modelId: rpcProviderModel.modelId,
								providerId: rpcProviderModel.providerId,
							},
						},
					})}\n`
				),
				new TextEncoder().encode(
					`${request("shutdown", "server/shutdown", {})}\n`
				),
			],
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(createFrame?.error).toMatchObject({
			message: expect.stringContaining(
				"Provider Model openai/gpt-5.6-luna is unavailable in this RPC Host."
			),
		});
		expect(activity).toEqual({ availabilityCalls: 1, externalizations: 0 });
		expect(stderrFrames).toEqual([]);
		expect(exitCode).toBe(0);
		const verification = await openSessionServices({
			policy: {
				cwd: rpcWorkspace,
				databasePath,
				workspace: rpcWorkspace,
			},
		});
		try {
			expect(await verification.store.listSessions()).toEqual([]);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await assembly.shutdown();
		await fs.rm(rpcWorkspace, { force: true, recursive: true });
	}
});

test("RPC uses the explicit selected Provider Model instead of a selectable Agent pin", async () => {
	const rpcWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-explicit-model-selection-")
	);
	const databasePath = path.join(rpcWorkspace, "sessions.sqlite");
	const pinnedModel: ProviderModel = {
		...rpcProviderModel,
		modelId: "rpc-agent-pinned-model",
	};
	const availabilityReads: {
		modelIds: string[];
		providerId: string | undefined;
	}[] = [];
	const usedModels: string[] = [];
	const providerCallStarted = Promise.withResolvers<void>();
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					"rpc-pinned": {
						description: "An Agent with a distinct pinned Provider Model.",
						model: `openai/${pinnedModel.modelId}`,
						role: "primary",
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const pinnedAgent = registry.selectableAgents.find(
		({ id }) => id === "rpc-pinned"
	);
	expect(pinnedAgent?.model).toMatchObject({
		modelId: pinnedModel.modelId,
		providerId: pinnedModel.providerId,
	});
	const assembly = await openSessionServices({
		policy: {
			cwd: rpcWorkspace,
			databasePath,
			workspace: rpcWorkspace,
		},
		sources: {
			createProviderCollection: () => {
				const collection = createProviderCollection({
					credentialStore: {
						delete: () => undefined,
						get: () => "fake-rpc-selection-key",
						set: () => undefined,
					},
					modelStore: { get: () => undefined, set: () => undefined },
				});
				collection.register({
					id: "openai",
					models: [rpcProviderModel, pinnedModel],
					resolveAuthorization: () => ({ authorization: { fake: true } }),
					async *streamChat(
						_request,
						context
					): AsyncGenerator<ProviderChatEvent> {
						usedModels.push(context.model.modelId);
						providerCallStarted.resolve();
						yield { type: "finish" };
					},
				});
				const getAvailable = collection.getAvailable.bind(collection);
				return {
					...collection,
					getAvailable: async (providerId) => {
						const models = await getAvailable(providerId);
						availabilityReads.push({
							modelIds: models.map(({ modelId }) => modelId),
							providerId,
						});
						return models;
					},
					getPluginProviderRegistrations: () => [] as const,
				};
			},
			registry: () => registry,
		},
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const initialized = Promise.withResolvers<void>();
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "explicit-rpc-model-selection" },
				cwd: rpcWorkspace,
				protocolVersion: 4,
			})}\n`
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${request("create", "session/create", {
				initialSubmission: { text: "Use the explicitly selected model." },
				selection: {
					agentId: "rpc-pinned",
					model: {
						modelId: rpcProviderModel.modelId,
						providerId: rpcProviderModel.providerId,
					},
				},
			})}\n`
		);
		await providerCallStarted.promise;
		yield new TextEncoder().encode(
			`${request("shutdown", "server/shutdown", {})}\n`
		);
	})();
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
					if ((JSON.parse(text) as { id?: string }).id === "initialize") {
						initialized.resolve();
					}
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(exitCode).toBe(0);
		expect(stderrFrames).toEqual([]);
		expect(createFrame?.error).toBeUndefined();
		expect(availabilityReads).toContainEqual({
			modelIds: [rpcProviderModel.modelId, pinnedModel.modelId],
			providerId: rpcProviderModel.providerId,
		});
		expect(usedModels).toEqual([rpcProviderModel.modelId]);
	} finally {
		await assembly.shutdown();
		await fs.rm(rpcWorkspace, { force: true, recursive: true });
	}
});

test("RPC session/submit rejects an unavailable model before storing its attachment or message", async () => {
	const rpcWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-submit-unavailable-model-")
	);
	const databasePath = path.join(rpcWorkspace, "sessions.sqlite");
	const activity = { externalizations: 0 };
	const availabilityReads: string[] = [];
	const localRecorder = createFakeProviderRecorder();
	const unrelatedProviderModel: ProviderModel = {
		modelId: "unrelated-rpc-model",
		protocolId: "fake-e2e-provider",
		providerId: "unrelated-rpc-provider",
	};
	const availableTurnCompleted = Promise.withResolvers<void>();
	const assembly = await openSessionServices({
		policy: {
			cwd: rpcWorkspace,
			databasePath,
			workspace: rpcWorkspace,
		},
		sources: {
			createProviderCollection: () => {
				const collection = createFakeProviderCollection(
					localRecorder,
					rpcProviderModel,
					[unrelatedProviderModel]
				);
				const getAvailable = collection.getAvailable.bind(collection);
				return {
					...collection,
					getAvailable: async (providerId) => {
						availabilityReads.push(providerId ?? "<all>");
						return await getAvailable(providerId);
					},
					getPluginProviderRegistrations: () => [] as const,
				};
			},
		},
	});
	const originalExternalizeAttachments =
		assembly.store.externalizeAttachments.bind(assembly.store);
	assembly.store.externalizeAttachments = async (...args) => {
		activity.externalizations += 1;
		return originalExternalizeAttachments(...args);
	};
	const { id: existingSessionId } = await assembly.store.createEmptySession({
		model: {
			modelId: modelId(rpcProviderModel.modelId),
			providerId: rpcProviderModel.providerId,
		},
	});
	let recordsBeforeSubmit =
		await assembly.store.listSessionRecords(existingSessionId);
	let recordsAtUnavailableSubmit = recordsBeforeSubmit;
	let sessionBeforeSubmit = await assembly.store.getSession(existingSessionId);
	let sessionAtUnavailableSubmit = sessionBeforeSubmit;
	let externalizationsAtUnavailableSubmit = -1;
	let providerCallsAtUnavailableSubmit = -1;
	let availabilityReadsAtUnavailableSubmit: string[] = [];
	let transcriptAtUnavailableSubmit: Record<string, unknown> | undefined;
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const initialized = Promise.withResolvers<void>();
	const sessionOpened = Promise.withResolvers<void>();
	const unavailableResponse = Promise.withResolvers<Record<string, unknown>>();
	const failedTurn = Promise.withResolvers<void>();
	const transcriptResponse = Promise.withResolvers<void>();
	const availableResponse = Promise.withResolvers<Record<string, unknown>>();
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "rpc-submit-model-preflight" },
				cwd: rpcWorkspace,
				protocolVersion: 4,
			})}\n`
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${request("open", "session/open", {
				sessionId: existingSessionId,
			})}\n`
		);
		await sessionOpened.promise;
		sessionBeforeSubmit = await assembly.store.getSession(existingSessionId);
		recordsBeforeSubmit =
			await assembly.store.listSessionRecords(existingSessionId);
		availabilityReads.length = 0;
		yield new TextEncoder().encode(
			`${request("unavailable-submit", "session/submit", {
				selection: {
					agentId: "build",
					model: {
						modelId: "not-available-in-this-host",
						providerId: rpcProviderModel.providerId,
					},
				},
				submission: {
					files: [
						{
							content: {
								data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
								encoding: "base64",
							},
							filename: "unavailable.png",
							mediaType: "image/png",
						},
					],
					text: "Reject this unavailable-model attachment.",
				},
			})}\n`
		);
		const unavailableFrame = await unavailableResponse.promise;
		if (unavailableFrame.error === undefined) {
			await Promise.race([failedTurn.promise, Bun.sleep(2000)]);
		}
		providerCallsAtUnavailableSubmit = localRecorder.requests.length;
		availabilityReadsAtUnavailableSubmit = [...availabilityReads];
		recordsAtUnavailableSubmit =
			await assembly.store.listSessionRecords(existingSessionId);
		sessionAtUnavailableSubmit =
			await assembly.store.getSession(existingSessionId);
		externalizationsAtUnavailableSubmit = activity.externalizations;
		yield new TextEncoder().encode(
			`${request("transcript", "session/getTranscript", {})}\n`
		);
		await transcriptResponse.promise;
		if (unavailableFrame.error !== undefined) {
			yield new TextEncoder().encode(
				`${request("available-submit", "session/submit", {
					selection: {
						agentId: "build",
						model: {
							modelId: rpcProviderModel.modelId,
							providerId: rpcProviderModel.providerId,
						},
					},
					submission: { text: "The available-model control succeeds." },
				})}\n`
			);
			await availableResponse.promise;
			await availableTurnCompleted.promise;
		}
		yield new TextEncoder().encode(
			`${request("shutdown", "server/shutdown", {})}\n`
		);
	})();
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
					const frame = JSON.parse(text) as Record<string, unknown>;
					if (frame.id === "initialize") {
						initialized.resolve();
					} else if (frame.id === "open") {
						sessionOpened.resolve();
					} else if (frame.id === "unavailable-submit") {
						unavailableResponse.resolve(frame);
					} else if (frame.id === "transcript") {
						transcriptAtUnavailableSubmit = frame.result as
							| Record<string, unknown>
							| undefined;
						transcriptResponse.resolve();
					} else if (frame.id === "available-submit") {
						availableResponse.resolve(frame);
					}
					if (frame.method === "session/event") {
						const params = frame.params as Record<string, unknown> | undefined;
						const wrapper = params?.event as
							| Record<string, unknown>
							| undefined;
						const event = wrapper?.event as Record<string, unknown> | undefined;
						if (event?.type === "agent-turn-failed") {
							failedTurn.resolve();
						}
						if (event?.type === "agent-turn-completed") {
							availableTurnCompleted.resolve();
						}
					}
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const unavailableFrame = frames.find(
			(frame) => frame.id === "unavailable-submit"
		);
		const availableFrame = frames.find(
			(frame) => frame.id === "available-submit"
		);
		expect(exitCode).toBe(0);
		expect(stderrFrames).toEqual([]);
		expect(unavailableFrame?.error).toMatchObject({
			message: expect.stringContaining("not-available-in-this-host"),
		});
		expect(availabilityReadsAtUnavailableSubmit).toEqual([
			rpcProviderModel.providerId,
		]);
		expect(externalizationsAtUnavailableSubmit).toBe(0);
		expect(providerCallsAtUnavailableSubmit).toBe(0);
		expect(recordsAtUnavailableSubmit).toEqual(recordsBeforeSubmit);
		expect(sessionAtUnavailableSubmit).toEqual(sessionBeforeSubmit);
		expect(transcriptAtUnavailableSubmit).toMatchObject({ messages: [] });
		expect(availableFrame?.error).toBeUndefined();
		expect(localRecorder.requests).toHaveLength(1);
		const verification = await openSessionServices({
			policy: {
				cwd: rpcWorkspace,
				databasePath,
				workspace: rpcWorkspace,
			},
		});
		try {
			expect(
				await verification.store.listSessionRecords(existingSessionId)
			).toHaveLength(2);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await assembly.shutdown();
		await fs.rm(rpcWorkspace, { force: true, recursive: true });
	}
});

test("RPC rejects a mismatched Host Plugin snapshot before persisting a built-in Session or attachments", async () => {
	const rpcWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-provider-snapshot-mismatch-")
	);
	const databasePath = path.join(rpcWorkspace, "sessions.sqlite");
	const staleRegistration: PluginProviderDescriptor = {
		connect: async () => {
			activity.connectCalls += 1;
		},
		createProvider: () => {
			throw new Error("The stale Plugin Provider must not be constructed.");
		},
		displayName: "Stale RPC Plugin Provider",
		pluginId: "stale-rpc-plugin",
		providerId: "stale-rpc-provider",
		sourceIdentity: "/trusted/plugins/stale-rpc.ts",
		sourcePath: "/trusted/plugins/stale-rpc.ts",
	};
	const activity = {
		availabilityCalls: 0,
		connectCalls: 0,
		credentialReads: 0,
		discoveries: 0,
		externalizations: 0,
		modelStoreReads: 0,
		restoreModelsCalls: 0,
		streams: 0,
	};
	const pluginRuntime = createPluginRuntime([], []);
	const assembly = await openSessionServices({
		policy: {
			cwd: rpcWorkspace,
			databasePath,
			workspace: rpcWorkspace,
		},
		sources: {
			createProviderCollection: () => {
				const collection = createProviderCollection({
					credentialStore: {
						delete: () => undefined,
						get: () => {
							activity.credentialReads += 1;
							return "fake-rpc-key";
						},
						set: () => undefined,
					},
					modelStore: {
						get: () => {
							activity.modelStoreReads += 1;
							return;
						},
						set: () => undefined,
					},
				});
				collection.register({
					id: rpcProviderModel.providerId,
					models: [rpcProviderModel],
					resolveAuthorization: () => ({
						authorization: { fake: true },
					}),
					discoverModels: () => {
						activity.discoveries += 1;
						return [];
					},
					async *streamChat(): AsyncGenerator<ProviderChatEvent> {
						activity.streams += 1;
						yield { type: "finish" };
					},
				});
				const getAvailable = collection.getAvailable.bind(collection);
				const restoreModels = collection.restoreModels.bind(collection);
				const reportedCollection: ProviderCollection &
					Readonly<{
						getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
					}> = {
					...collection,
					getAvailable: async () => {
						activity.availabilityCalls += 1;
						return getAvailable();
					},
					getPluginProviderRegistrations: () => [staleRegistration],
					restoreModels: async () => {
						activity.restoreModelsCalls += 1;
						await restoreModels();
					},
				};
				return reportedCollection;
			},
			pluginRuntime: () => pluginRuntime,
		},
	});
	const originalExternalizeAttachments = assembly.store.externalizeAttachments;
	assembly.store.externalizeAttachments = async (...args) => {
		activity.externalizations += 1;
		return originalExternalizeAttachments(...args);
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const requestsBefore = recorder.requests.length;
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input: [
				new TextEncoder().encode(
					`${request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "provider-snapshot-mismatch" },
						cwd: rpcWorkspace,
						protocolVersion: 4,
					})}\n`
				),
				new TextEncoder().encode(
					`${request("create", "session/create", {
						initialSubmission: {
							text: "Do not persist before Host validation.",
						},
						selection: {
							agentId: "build",
							model: { modelId: "gpt-5.6-luna", providerId: "openai" },
						},
					})}\n`
				),
				new TextEncoder().encode(
					`${request("shutdown", "server/shutdown", {})}\n`
				),
			],
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(exitCode).toBe(0);
		expect(createFrame?.error).toMatchObject({
			message: expect.stringContaining(
				"registrations do not match the current trusted registrations"
			),
		});
		expect(stderrFrames).toEqual([]);
		expect(activity).toEqual({
			availabilityCalls: 0,
			connectCalls: 0,
			credentialReads: 0,
			discoveries: 0,
			externalizations: 0,
			modelStoreReads: 0,
			restoreModelsCalls: 0,
			streams: 0,
		});
		expect(recorder.requests).toHaveLength(requestsBefore);
		const verification = await openSessionServices({
			policy: {
				cwd: rpcWorkspace,
				databasePath,
				workspace: rpcWorkspace,
			},
		});
		try {
			expect(await verification.store.listSessions()).toEqual([]);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await Promise.all([assembly.shutdown(), pluginRuntime.shutdown()]);
		await fs.rm(rpcWorkspace, { force: true, recursive: true });
	}
});

test("RPC maps an unavailable Provider SDK composition to an actionable error", async () => {
	const legacyWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-legacy-runtime-")
	);
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const assembly = await openSessionServices({
		policy: {
			cwd: legacyWorkspace,
			databasePath: path.join(legacyWorkspace, "sessions.sqlite"),
			workspace: legacyWorkspace,
		},
		sources: {
			createProviderCollection: () => undefined,
			registry: () => registry,
		},
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input: [
				new TextEncoder().encode(
					`${request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "legacy-host-test" },
						cwd: legacyWorkspace,
						protocolVersion: 4,
					})}\n`
				),
				new TextEncoder().encode(
					`${request("create", "session/create", {
						initialSubmission: { text: "Do not use legacy dispatch." },
						selection: {
							agentId: "build",
							model: { modelId: "gpt-5.6-luna", providerId: "openai" },
						},
					})}\n`
				),
				new TextEncoder().encode(
					`${request("shutdown", "server/shutdown", {})}\n`
				),
			],
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(exitCode).toBe(0);
		expect(createFrame?.error).toMatchObject({
			data: {
				code: "provider_sdk_required",
				executionMode: "rpc",
				stage: "host",
			},
			message: expect.stringContaining(
				"Connect the Provider in Interactive Mode"
			),
		});
		expect(stderrFrames).toEqual([]);
	} finally {
		await assembly.shutdown();
		await fs.rm(legacyWorkspace, { force: true, recursive: true });
	}
});

test("RPC session/open keeps a held Session Writer as a refusal", async () => {
	const conflictDatabasePath = path.join(workspace, "writer-conflict.sqlite");
	const ownerDatabase = createDatabase(conflictDatabasePath);
	const ownerStore = createDrizzleSessionStore(ownerDatabase.db, {
		attachmentRoot: path.join(workspace, "writer-conflict-attachments"),
		snapshotRoot: path.join(workspace, "writer-conflict-snapshots"),
		workspaceRoot: workspace,
	});
	const { id: sessionId } = await ownerStore.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("writer-conflict-message"),
			parts: [{ text: "existing session", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("writer-conflict-turn"),
	});
	const rpcAssembly = await openSessionServices({
		policy: { cwd: workspace, databasePath: conflictDatabasePath, workspace },
		sources: {},
	});
	const ownerWriter = await ownerStore.acquireSessionWriter(sessionId, {
		executionMode: "interactive",
	});
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const input = [
		new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "writer-conflict-test" },
				cwd: workspace,
				protocolVersion: 4,
			})}\n`
		),
		new TextEncoder().encode(
			`${request("open", "session/open", { sessionId })}\n`
		),
		new TextEncoder().encode(`${request("shutdown", "server/shutdown", {})}\n`),
	];

	try {
		const exitCode = await runRpc({
			composeServices: async () => rpcAssembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const openFrame = frames.find((frame) => frame.id === "open");

		expect(exitCode).toBe(0);
		expect(stderrFrames).toEqual([]);
		expect(openFrame?.error).toMatchObject({
			data: { code: "session_in_use" },
		});
	} finally {
		await ownerWriter.release();
		await rpcAssembly.shutdown();
		ownerDatabase.sqlite.close();
	}
});

test("RPC session opening keeps lock refusals request-scoped", async () => {
	const failureDatabasePath = path.join(
		workspace,
		"writer-lock-failure.sqlite"
	);
	const failureAssembly = await openSessionServices({
		policy: { cwd: workspace, databasePath: failureDatabasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
	});
	const { id: sessionId } = await failureAssembly.store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("lock-failure-message"),
			parts: [{ text: "existing session", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("lock-failure-turn"),
	});
	const acquireSessionWriter = failureAssembly.store.acquireSessionWriter;
	failureAssembly.store.acquireSessionWriter = async () => {
		throw new SessionWriterLockFailureError(new Error("lock unavailable"));
	};
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const input = [
		new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "lock-failure-test" },
				cwd: workspace,
				protocolVersion: 4,
			})}\n`
		),
		new TextEncoder().encode(
			`${request("open", "session/open", { sessionId })}\n`
		),
		new TextEncoder().encode(
			`${request("create", "session/create", {
				initialSubmission: { text: "new RPC session" },
				selection: {
					agentId: "build",
					model: { modelId: "gpt-5.6-luna", providerId: "openai" },
				},
			})}\n`
		),
		new TextEncoder().encode(`${request("shutdown", "server/shutdown", {})}\n`),
	];

	try {
		const exitCode = await runRpc({
			composeServices: async () => failureAssembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		expect(exitCode).toBe(0);
		expect(stderrFrames).toEqual([]);
		expect(frames.find((frame) => frame.id === "open")?.error).toMatchObject({
			data: { code: "session_lock_failed" },
		});
		expect(frames.find((frame) => frame.id === "create")?.error).toMatchObject({
			data: { code: "session_lock_failed" },
		});
		expect(frames.some((frame) => frame.method === "server/fatal")).toBe(false);
	} finally {
		failureAssembly.store.acquireSessionWriter = acquireSessionWriter;
		await failureAssembly.shutdown();
	}
});

test("raw JSONL target switches retain background Sessions but stream only the active target", async () => {
	const switchAssembly = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "session-switch.sqlite"),
			workspace,
		},
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
	});
	const model = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai" as const,
	};
	const createSeededSession = async (key: string) =>
		switchAssembly.store.createSession({
			agent: agentId("build"),
			message: {
				id: sessionMessageId(`${key}-seed`),
				parts: [{ text: `${key} seed`, type: "text" }],
				role: "user",
			},
			model,
			turnId: agentTurnId(`${key}-seed-turn`),
		});
	const firstSession = await createSeededSession("background");
	const secondSession = await createSeededSession("active");
	const initialized = Promise.withResolvers<void>();
	const firstBound = Promise.withResolvers<void>();
	const firstModelStarted = Promise.withResolvers<void>();
	const secondBound = Promise.withResolvers<void>();
	const secondModelStarted = Promise.withResolvers<void>();
	const secondModelCompleted = Promise.withResolvers<void>();
	const backgroundModelCompleted = Promise.withResolvers<void>();
	const firstRebound = Promise.withResolvers<void>();
	const thirdModelStarted = Promise.withResolvers<void>();
	const thirdModelCompleted = Promise.withResolvers<void>();
	const releaseFirstModel = Promise.withResolvers<void>();
	let firstModelHeld = false;
	let secondModelSeen = false;
	let thirdModelSeen = false;
	const previousBeforeStep = recorder.beforeChat;
	recorder.beforeChat = async (request) => {
		const latestUserText = request.messages
			.filter(({ role }) => role === "user")
			.at(-1)
			?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		if (latestUserText === "pause the background Session" && !firstModelHeld) {
			firstModelHeld = true;
			firstModelStarted.resolve();
			await releaseFirstModel.promise;
		} else if (latestUserText === "run the active Session") {
			secondModelSeen = true;
			secondModelStarted.resolve();
		} else if (latestUserText === "run the background Session again") {
			thirdModelSeen = true;
			thirdModelStarted.resolve();
		}
	};
	const unsubscribeManager = switchAssembly.capabilities
		.getSessionHostManager()
		.onEvent((event) => {
			if (
				event.type === "agent-turn-event" &&
				event.sessionId === firstSession.id &&
				event.event.type === "agent-turn-completed"
			) {
				backgroundModelCompleted.resolve();
			}
		});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const initialize = `${request("initialize", "initialize", {
		capabilities: {},
		clientInfo: { name: "session-switch-test" },
		cwd: workspace,
		protocolVersion: 4,
	})}\n`;
	const openFirst = `${request("open-first", "session/open", {
		sessionId: firstSession.id,
	})}\n`;
	const submitFirst = `${request("submit-first", "session/submit", {
		submission: { text: "pause the background Session" },
	})}\n`;
	const openSecond = `${request("open-second", "session/open", {
		sessionId: secondSession.id,
	})}\n`;
	const submitSecond = `${request("submit-second", "session/submit", {
		submission: { text: "run the active Session" },
	})}\n`;
	const reopenFirst = `${request("reopen-first", "session/open", {
		sessionId: firstSession.id,
	})}\n`;
	const submitThird = `${request("submit-third", "session/submit", {
		submission: { text: "run the background Session again" },
	})}\n`;
	const shutdown = `${request("shutdown-switch-test", "server/shutdown", {})}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(initialize);
		await initialized.promise;
		yield new TextEncoder().encode(openFirst);
		await firstBound.promise;
		yield new TextEncoder().encode(submitFirst);
		await firstModelStarted.promise;
		yield new TextEncoder().encode(openSecond);
		await secondBound.promise;
		yield new TextEncoder().encode(submitSecond);
		await secondModelStarted.promise;
		await secondModelCompleted.promise;
		releaseFirstModel.resolve();
		await backgroundModelCompleted.promise;
		yield new TextEncoder().encode(reopenFirst);
		await firstRebound.promise;
		yield new TextEncoder().encode(submitThird);
		await thirdModelStarted.promise;
		await thirdModelCompleted.promise;
		yield new TextEncoder().encode(shutdown);
	})();
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	let exitCode: number | undefined;
	const run = runRpc({
		composeServices: async () => switchAssembly,
		input,
		stderr: {
			write: (text: string): undefined => {
				stderrFrames.push(text);
			},
		},
		stdout: {
			write: (text: string): undefined => {
				stdoutFrames.push(text);
				const frame = JSON.parse(text) as {
					id?: string;
					method?: string;
					params?: {
						event?: {
							kind?: string;
							sessionId?: string;
						};
						state?: {
							sessionId?: string;
							status?: string;
						};
					};
				};
				if (frame.id === "initialize") {
					initialized.resolve();
				} else if (frame.id === "open-first") {
					firstBound.resolve();
				} else if (frame.id === "open-second") {
					secondBound.resolve();
				} else if (frame.id === "reopen-first") {
					firstRebound.resolve();
				}
				if (
					frame.method === "session/stateChanged" &&
					frame.params?.state?.status === "idle"
				) {
					if (
						secondModelSeen &&
						frame.params.state.sessionId === secondSession.id
					) {
						secondModelCompleted.resolve();
					}
					if (
						thirdModelSeen &&
						frame.params.state.sessionId === firstSession.id
					) {
						thirdModelCompleted.resolve();
					}
				}
			},
		},
	});
	try {
		exitCode = await run;
	} finally {
		releaseFirstModel.resolve();
		recorder.beforeChat = previousBeforeStep;
		unsubscribeManager();
		await switchAssembly.shutdown();
	}
	const frames = stdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	expect(exitCode).toBe(0);
	expect(stderrFrames).toEqual([]);
	expect(frames.some((frame) => frame.id === "open-first")).toBe(true);
	expect(frames.some((frame) => frame.id === "open-second")).toBe(true);
	expect(frames.some((frame) => frame.id === "reopen-first")).toBe(true);
	expect(
		frames.some((frame) => {
			const params = frame.params as
				| { event?: { kind?: string; sessionId?: string } }
				| undefined;
			return (
				frame.method === "session/event" &&
				(params?.event?.kind === "background-agent-turn" ||
					params?.event?.kind === "delegated-agent-turn") &&
				params.event.sessionId === firstSession.id
			);
		})
	).toBe(false);
});
