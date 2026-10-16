import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema, toModelId } from "@wincode/agent-core";
import {
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
	type ProviderChatRequest,
	type ProviderCollection,
	type ProviderModel,
} from "@wincode/ai/sdk";
import {
	type AgentRegistry,
	buildAgentRegistry,
	resolveActiveAgentId,
} from "../modules/agents/registry";
import {
	type OneShotCompositionInput,
	type OneShotDependencies,
	runJsonMode,
	runPrintMode,
} from "../modules/application/modes/one-shot";
import type {
	ApplicationContext,
	TextWriter,
} from "../modules/application/modes/types";
import { createApplicationPluginComposition } from "../modules/application/plugin-composition";
import type { PluginAgentRegistration } from "../modules/plugins/public";
import {
	createPluginRuntime,
	type PluginProviderDescriptor,
	type PluginRuntime,
} from "../modules/plugins/runtime";
import { createSessionHost } from "../modules/sessions/host/session-host";
import {
	openSessionServices,
	type SessionServices,
	type SessionServicesSources,
} from "../modules/sessions/host/session-services";
import {
	createInteractiveSessionProviderCollection,
	type InteractiveSessionProviderCollectionOptions,
	pluginProvidersFromRuntime,
} from "../modules/sessions/provider-collection";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	type FakeProviderStepScript,
} from "./support/e2e-fake-runtime";

const fakeRecorder = createFakeProviderRecorder();

const withTrustedWorktreePlugins = async <Value>(
	operation: () => Promise<Value>
): Promise<Value> => {
	const isolatedHome = await fs.mkdtemp(
		path.join("/tmp", "wincode-trusted-plugin-home-")
	);
	const trustDirectory = path.join(isolatedHome, ".wincode");
	await Bun.write(
		path.join(trustDirectory, "project-trust.json"),
		JSON.stringify({
			decisions: [
				{ directory: await fs.realpath(process.cwd()), decision: "trust" },
			],
			version: 1,
		})
	);
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const homeDirSpy = spyOn(os, "homedir").mockReturnValue(isolatedHome);
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	try {
		return await operation();
	} finally {
		homeDirSpy.mockRestore();
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(isolatedHome, { force: true, recursive: true });
	}
};

const workspace = await fs.mkdtemp(path.join("/tmp", "wincode-one-shot-"));
const registry = buildAgentRegistry(
	fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {
			agents: {
				review: {
					description: "Review changes without editing files.",
					role: "primary",
				},
			},
		},
		sourceFor: () => undefined,
		sources: [],
	})
);
const buildConfiguredAgentRegistry = (
	agents: Record<string, unknown>
): AgentRegistry =>
	buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: { agents },
			sourceFor: () => undefined,
			sources: [],
		})
	);

const configuredReviewRegistry = buildConfiguredAgentRegistry({
	review: {
		description: "Review changes without editing files.",
		thinking_level: "high",
		model: "openai/gpt-5.6-luna",
		role: "primary",
	},
});
const sdkOneShotProviderModel: ProviderModel = {
	capabilities: ["reasoning", "text", "tools"],
	modelId: "one-shot-model-v2",
	providerId: "openai",
	protocolId: "fake-e2e-provider",
	reasoningEfforts: ["high"],
};
const sdkPinnedOneShotRegistry = buildConfiguredAgentRegistry({
	review: {
		description: "Review with an unavailable SDK Model pin.",
		model: "openai/old-model-v1",
		role: "primary",
	},
});
const oneShotPluginId = "one-shot-provider-plugin";
const oneShotPluginProviderId = "one-shot-plugin-provider";
const oneShotPluginModel: ProviderModel = {
	capabilities: ["reasoning", "text", "tools"],
	modelId: "one-shot-plugin-model-v1",
	providerId: oneShotPluginProviderId,
	protocolId: "fake-one-shot-plugin-provider",
	reasoningEfforts: ["low"],
};
const oneShotPluginAgentRegistration = (): PluginAgentRegistration => ({
	agent: {
		description: "Review using its current Plugin Provider pin.",
		displayName: "One-Shot Plugin Agent",
		id: agentIdSchema.parse("one-shot-plugin-agent"),
		instructions: "Review the requested work.",
		role: "primary",
	},
	model: `${oneShotPluginProviderId}/${oneShotPluginModel.modelId}`,
	source: { path: "/trusted/plugins/one-shot-agent.md", scope: "user" },
});
const oneShotPluginAgentRegistry = (
	registration: PluginAgentRegistration
): AgentRegistry =>
	buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: { agents: {} },
			sourceFor: () => undefined,
			sources: [],
		}),
		{ pluginAgentRegistrations: [registration] }
	);
const oneShotPluginRequests: string[] = [];
const oneShotPluginRegistration = (
	sourceIdentity: string,
	requests: string[]
): PluginProviderDescriptor => ({
	connect: async () => undefined,
	createProvider: (): Provider => ({
		id: oneShotPluginProviderId,
		models: [oneShotPluginModel],
		resolveAuthorization: () => ({ authorization: { fake: true } }),
		async *streamChat() {
			requests.push(sourceIdentity);
			yield { delta: "Plugin response", type: "text-delta" };
			yield { type: "finish" };
		},
	}),
	displayName: "One-Shot fake Plugin Provider",
	pluginId: oneShotPluginId,
	providerId: oneShotPluginProviderId,
	sourceIdentity,
	sourcePath: sourceIdentity,
});
const oneShotPluginRuntime = (
	registration: PluginProviderDescriptor,
	agents: readonly PluginAgentRegistration[] = []
): PluginRuntime =>
	createPluginRuntime(
		[
			{
				...(agents.length === 0 ? {} : { agents }),
				commands: [],
				id: registration.pluginId,
				providers: [registration],
				sourcePath: registration.sourcePath,
				tools: [],
				workspace,
			},
		],
		[]
	);
const oneShotPluginProviderCollectionFactory: SessionServicesSources["createProviderCollection"] =
	async (
		pluginRuntime,
		sessionId,
		allowedProviderIds,
		allowedProviderSources
	) => {
		const pluginProviders = pluginProvidersFromRuntime(
			pluginRuntime,
			sessionId,
			allowedProviderIds,
			allowedProviderSources
		);
		if (pluginProviders.length !== 1) {
			throw new Error("The fake One-Shot Plugin Provider was not trusted.");
		}
		return createInteractiveSessionProviderCollection({
			credentialStore: {
				delete: () => undefined,
				get: () => ({ fake: true }),
				set: () => undefined,
			},
			modelStore: { get: () => undefined, set: () => undefined },
			pluginProviders,
			...(sessionId === undefined ? {} : { sessionId }),
		});
	};

const composeServicesDetailedFor =
	(
		agentRegistry: AgentRegistry,
		createProviderCollection?: SessionServicesSources["createProviderCollection"]
	) =>
	async ({
		configRuntime,
		cwd,
		pluginRuntime: providedPluginRuntime,
		disabledPluginIds,
		pluginPaths,
		workspace: root,
	}: OneShotCompositionInput) => {
		const composition = createApplicationPluginComposition();
		const services = await openSessionServices({
			policy: {
				cwd,
				databasePath: path.join(root, "sessions.sqlite"),
				plugins: {
					disabledIdentifiers: disabledPluginIds ?? [],
					distributionPackages: composition.distributionPlugins,
					paths: pluginPaths ?? [],
				},
				workspace: root,
			},
			sources: {
				createProviderCollection:
					createProviderCollection ??
					(() => createFakeProviderCollection(fakeRecorder)),
				registry: () => agentRegistry,
				turnToolResolver: () => composition.turnToolResolver,
				...(configRuntime === undefined
					? {}
					: { configRuntime: () => configRuntime }),
				...(providedPluginRuntime === undefined
					? {}
					: { pluginRuntime: () => providedPluginRuntime }),
			},
		});
		return { services };
	};
const composeServicesFor = (agentRegistry: AgentRegistry) =>
	composeServicesDetailedFor(agentRegistry);
const composeServices = composeServicesFor(registry);
const composeConfiguredReview = composeServicesFor(configuredReviewRegistry);

const writer = (): { text: string; writer: TextWriter } => {
	const state = { text: "" };
	return {
		get text() {
			return state.text;
		},
		writer: {
			write: (text: string): void => {
				state.text += text;
			},
		},
	};
};

type SelectorOptions = Readonly<{
	agent?: string;
	model?: string;
	thinkingLevel?: string;
}>;
const context = (
	mode: "json" | "print",
	prompt: string | undefined,
	stdout: TextWriter,
	stderr: TextWriter,
	session?: string,
	stdin: AsyncIterable<Uint8Array> = (async function* (): AsyncGenerator<Uint8Array> {
		yield* [];
	})(),
	stdinIsTTY = prompt !== undefined,
	selectors: SelectorOptions = {},
	workingDirectory = workspace
): ApplicationContext => ({
	args: [],
	cwd: workingDirectory,
	invocation: {
		mode,
		...(prompt === undefined ? {} : { prompt }),
		...(session === undefined ? {} : { session }),
		...selectors,
	},
	stderr,
	stdin,
	stdinIsTTY,
	stdout,
});

const dependencies: OneShotDependencies = { composeServices };
const configuredReviewDependencies: OneShotDependencies = {
	composeServices: composeConfiguredReview,
};

test("configured Agents retain a model-supported ThinkingLevel", () => {
	const configured = buildConfiguredAgentRegistry({
		"level-review": {
			description: "Review with a selected ThinkingLevel.",
			thinking_level: "high",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
		},
	});

	expect(configured.configuredAgents).toHaveLength(1);
	expect(
		configured.configuredAgents.find(({ id }) => id === "level-review")
	).toMatchObject({
		thinkingLevel: "high",
		model: { modelId: "claude-sonnet-5", providerId: "anthropic" },
	});
	expect(
		configured.diagnostics.filter(({ severity }) => severity === "error")
	).toEqual([]);
});

test("agent selection offers only Build and falls back from stale Plan choices", () => {
	const buildId = agentIdSchema.parse("build");
	const removedPlanId = agentIdSchema.parse("plan");
	const defaultRegistry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const planDefaultRegistry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: { default_agent: "plan" },
			sourceFor: () => undefined,
			sources: [],
		})
	);

	expect(defaultRegistry.selectableAgents.map((agent) => agent.id)).toEqual([
		buildId,
	]);
	expect(defaultRegistry.defaultAgentId).toBe(buildId);
	expect(resolveActiveAgentId(defaultRegistry, removedPlanId)).toBe(buildId);
	expect(planDefaultRegistry.defaultAgentId).toBe(buildId);
	expect(planDefaultRegistry.selectableAgents.map((agent) => agent.id)).toEqual(
		[buildId]
	);
	expect(planDefaultRegistry.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "invalid-agent",
			configPath: ["default_agent"],
		})
	);
});

test("configured Agents preserve SDK Model pins and validate ThinkingLevel syntax only", () => {
	const configured = buildConfiguredAgentRegistry({
		"legacy-effort": {
			description: "The removed effort key is not valid.",
			effort: "high",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
		},
		"legacy-mode": {
			description: "The removed reasoning mode key is not valid.",
			model: "anthropic/claude-sonnet-5",
			reasoningMode: "none",
			role: "primary",
		},
		"legacy-variant": {
			description: "The old variant key is not valid.",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
			variant: "high",
		},
		"unsupported-level": {
			description: "This model has no selectable ThinkingLevel.",
			thinking_level: "low",
			model: "opencode-go/grok-4.6",
			role: "primary",
		},
		"invalid-level": {
			description: "ThinkingLevel values must be valid identifiers.",
			thinking_level: "extreme",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
		},
	});

	expect(configured.configuredAgents).toHaveLength(1);
	expect(
		configured.agents.find(({ id }) => id === "unsupported-level")
	).toMatchObject({
		model: { modelId: "grok-4.6", providerId: "opencode-go" },
		thinkingLevel: "low",
	});
	for (const [agentId, field] of [
		["legacy-effort", "effort"],
		["legacy-mode", "reasoningMode"],
		["legacy-variant", "variant"],
		["invalid-level", "thinking_level"],
	] as const) {
		expect(configured.diagnostics).toContainEqual(
			expect.objectContaining({
				configPath: ["agents", agentId, field],
				severity: "error",
			})
		);
	}
});

test("built-in Agent patches retain ThinkingLevels for exact Provider Model validation", () => {
	const configured = buildConfiguredAgentRegistry({
		build: {
			model: "opencode-go/grok-4.6",
			thinking_level: "low",
		},
	});
	const build = configured.agents.find(({ id }) => id === "build");

	expect(build).toMatchObject({
		model: { modelId: "grok-4.6", providerId: "opencode-go" },
		thinkingLevel: "low",
	});
	expect(configured.diagnostics).not.toContainEqual(
		expect.objectContaining({
			configPath: ["agents", "build", "thinking_level"],
			severity: "error",
		})
	);
});

afterAll(async () => {
	await fs.rm(workspace, { force: true, recursive: true });
});

test("Print mode creates a durable One-Shot Session and writes assistant text only", async () => {
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runPrintMode(
		context("print", "hello from print", stdout.writer, stderr.writer),
		dependencies
	);

	expect(exitCode).toBe(0);
	expect(stdout.text).toBe("E2E chat response");
	expect(stderr.text).toBe("");
	const verification = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "sessions.sqlite"),
			workspace,
		},
		sources: {
			registry: () => registry,
		},
	});
	let sessionId: string | undefined;
	try {
		const sessions = await verification.store.listSessions();
		expect(sessions).toHaveLength(1);
		sessionId = sessions[0]?.id;
	} finally {
		await verification.shutdown();
	}
	if (sessionId === undefined) {
		throw new Error("Expected the Print mode session to have an id.");
	}

	const continued = writer();
	const continuedErrors = writer();
	const continuedExitCode = await runPrintMode(
		context(
			"print",
			"continue the existing session",
			continued.writer,
			continuedErrors.writer,
			sessionId
		),
		dependencies
	);
	expect(continuedExitCode).toBe(0);
	expect(continued.text).toBe("E2E chat response");
	expect(continuedErrors.text).toBe("");
	const overridden = writer();
	const overrideErrors = writer();
	const overrideExitCode = await runPrintMode(
		context(
			"print",
			"override the restored agent",
			overridden.writer,
			overrideErrors.writer,
			sessionId,
			undefined,
			true,
			{ agent: "review" }
		),
		dependencies
	);
	expect(overrideExitCode).toBe(0);
	expect(overridden.text).toBe("E2E chat response");
	expect(overrideErrors.text).toBe("");
	const finalVerification = (
		await composeServices({
			cwd: workspace,
			workspace,
		})
	).services;
	try {
		const [session] = await finalVerification.store.listSessions();
		if (session === undefined) {
			throw new Error("Expected the overridden One-Shot Session.");
		}
		const records = await finalVerification.store.listSessionRecords(
			session.id
		);
		expect(records.at(-1)?.agentId).toBe(agentIdSchema.parse("review"));
	} finally {
		await finalVerification.shutdown();
	}
});

test("one-shot ThinkingLevel selectors override configured and restored choices", async () => {
	const reasoningWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-thinking-level-")
	);
	try {
		const initialOutput = writer();
		const initialErrors = writer();
		const initialExitCode = await runPrintMode(
			context(
				"print",
				"choose a configured Agent ThinkingLevel",
				initialOutput.writer,
				initialErrors.writer,
				undefined,
				undefined,
				true,
				{ agent: "review", thinkingLevel: "medium" },
				reasoningWorkspace
			),
			configuredReviewDependencies
		);
		expect(initialExitCode).toBe(0);
		expect(initialOutput.text).toBe("E2E chat response");
		expect(initialErrors.text).toBe("");
		const firstVerification = (
			await composeConfiguredReview({
				cwd: reasoningWorkspace,
				workspace: reasoningWorkspace,
			})
		).services;
		let sessionId: string | undefined;
		try {
			const sessions = await firstVerification.store.listSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.thinkingLevel).toBe("medium");
			sessionId = sessions[0]?.id;
		} finally {
			await firstVerification.shutdown();
		}
		if (sessionId === undefined) {
			throw new Error(
				"Expected the selected ThinkingLevel to persist in the Session."
			);
		}

		const continuationOutput = writer();
		const continuationErrors = writer();
		const continuationExitCode = await runPrintMode(
			context(
				"print",
				"override the restored ThinkingLevel",
				continuationOutput.writer,
				continuationErrors.writer,
				sessionId,
				undefined,
				true,
				{ agent: "review", thinkingLevel: "low" },
				reasoningWorkspace
			),
			configuredReviewDependencies
		);
		expect(continuationExitCode).toBe(0);
		expect(continuationOutput.text).toBe("E2E chat response");
		expect(continuationErrors.text).toBe("");
		const finalVerification = (
			await composeConfiguredReview({
				cwd: reasoningWorkspace,
				workspace: reasoningWorkspace,
			})
		).services;
		try {
			const sessions = await finalVerification.store.listSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.thinkingLevel).toBe("low");
		} finally {
			await finalVerification.shutdown();
		}
	} finally {
		await fs.rm(reasoningWorkspace, { force: true, recursive: true });
	}
});

test("one-shot invalid explicit choices name their field and fail before send", async () => {
	const invalidWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-invalid-thinking-level-")
	);
	try {
		const invalidChoices: readonly {
			readonly field: string;
			readonly selectors: SelectorOptions;
		}[] = [
			{
				field: "--thinking-level",
				selectors: { thinkingLevel: "extreme" },
			},
		];
		const initialChatRequestCount = fakeRecorder.requests.filter(
			({ kind }) => kind === "chat"
		).length;
		for (const { field, selectors } of invalidChoices) {
			const stdout = writer();
			const stderr = writer();
			const exitCode = await runPrintMode(
				context(
					"print",
					"invalid ThinkingLevel selector",
					stdout.writer,
					stderr.writer,
					undefined,
					undefined,
					true,
					{ model: "openai/gpt-5.6-luna", ...selectors },
					invalidWorkspace
				),
				dependencies
			);
			expect(exitCode).toBe(1);
			expect(stdout.text).toBe("");
			expect(stderr.text).toContain(field);
		}
		expect(
			fakeRecorder.requests.filter(({ kind }) => kind === "chat")
		).toHaveLength(initialChatRequestCount);
		const verification = await composeServices({
			cwd: invalidWorkspace,
			workspace: invalidWorkspace,
		});
		try {
			expect(await verification.services.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await fs.rm(invalidWorkspace, { force: true, recursive: true });
	}
});

test("Print and JSON modes report a held Session Writer conflict", async () => {
	const seed = writer();
	const seedErrors = writer();
	expect(
		await runPrintMode(
			context(
				"print",
				"seed the writer conflict session",
				seed.writer,
				seedErrors.writer
			),
			dependencies
		)
	).toBe(0);

	const lookup = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "sessions.sqlite"),
			workspace,
		},
		sources: {
			registry: () => registry,
		},
	});
	const sessions = await lookup.store.listSessions();
	const sessionId = sessions.at(-1)?.id;
	await lookup.shutdown();
	if (sessionId === undefined) {
		throw new Error("Expected a seeded Session for the writer conflict test.");
	}

	const holderAssembly = (
		await composeServices({
			cwd: workspace,
			workspace,
		})
	).services;
	const holder = await createSessionHost({
		capabilities: holderAssembly.capabilities,
		sessionId,
	});
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"should not acquire the held session",
				stdout.writer,
				stderr.writer,
				sessionId
			),
			dependencies
		);
		expect(exitCode).toBe(1);
		expect(stdout.text).toBe("");
		expect(stderr.text).toContain("already in use");
		const jsonStdout = writer();
		const jsonStderr = writer();
		const jsonExitCode = await runJsonMode(
			context(
				"json",
				"should not acquire the held session",
				jsonStdout.writer,
				jsonStderr.writer,
				sessionId
			),
			dependencies
		);
		expect(jsonExitCode).toBe(1);
		expect(JSON.parse(jsonStdout.text)).toEqual({
			error: "Session is already in use by another Session Host.",
		});
		expect(jsonStderr.text).toContain("already in use");
	} finally {
		await holder.shutdown();
		await holderAssembly.shutdown();
	}
});
test("JSON mode emits projected Agent events without JSON-RPC envelopes", async () => {
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runJsonMode(
		context("json", "hello from json", stdout.writer, stderr.writer),
		dependencies
	);
	const frames = stdout.text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

	expect(exitCode).toBe(0);
	expect(stderr.text).toBe("");
	expect(frames.map((frame) => frame.type)).toEqual([
		"agent-turn-started",
		"model-step-started",
		"text-delta",
		"model-step-finished",
		"agent-turn-completed",
	]);
	expect(frames.every((frame) => !("jsonrpc" in frame))).toBe(true);
});

test("Print mode reads one Submission from non-TTY stdin", async () => {
	const stdout = writer();
	const stderr = writer();
	const stdin = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode("hello from stdin");
	})();
	const exitCode = await runPrintMode(
		context(
			"print",
			undefined,
			stdout.writer,
			stderr.writer,
			undefined,
			stdin,
			false
		),
		dependencies
	);

	expect(exitCode).toBe(0);
	expect(stdout.text).toBe("E2E chat response");
	expect(stderr.text).toBe("");
});

test("one-shot input rejects empty submissions before creating a Session", async () => {
	const emptyWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-empty-submission-")
	);
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"   ",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{},
				emptyWorkspace
			),
			dependencies
		);

		expect(exitCode).toBe(1);
		const verification = await composeServices({
			cwd: emptyWorkspace,
			workspace: emptyWorkspace,
		});
		try {
			expect(await verification.services.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await fs.rm(emptyWorkspace, { force: true, recursive: true });
	}
});

test("headless Print and JSON report actionable SDK authentication failures without secrets", async () => {
	const disconnectedWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-headless-sdk-auth-")
	);
	const credentialStore = new Map<string, unknown>();
	const modelStore = new Map<string, readonly ProviderModel[]>();
	const composeWithoutCredentials = composeServicesDetailedFor(
		registry,
		async () =>
			createInteractiveSessionProviderCollection({
				credentialStore: {
					delete: (providerId) => {
						credentialStore.delete(providerId);
					},
					get: (providerId) => credentialStore.get(providerId),
					set: (providerId, credential) => {
						credentialStore.set(providerId, credential);
					},
				},
				modelStore: {
					get: (providerId) => modelStore.get(providerId),
					set: (providerId, models) => {
						modelStore.set(providerId, models);
					},
				},
			} satisfies InteractiveSessionProviderCollectionOptions)
	);
	try {
		const printStdout = writer();
		const printStderr = writer();
		const printExitCode = await runPrintMode(
			context(
				"print",
				"send without a connection",
				printStdout.writer,
				printStderr.writer,
				undefined,
				undefined,
				true,
				{},
				disconnectedWorkspace
			),
			{ composeServices: composeWithoutCredentials }
		);
		expect(printExitCode).toBe(1);
		expect(printStdout.text).toBe("");
		expect(printStderr.text).toContain("Connect openai in Interactive Mode");
		expect(printStderr.text).not.toContain("fake-e2e-provider-key");

		const jsonStdout = writer();
		const jsonStderr = writer();
		const jsonExitCode = await runJsonMode(
			context(
				"json",
				"send without a connection",
				jsonStdout.writer,
				jsonStderr.writer,
				undefined,
				undefined,
				true,
				{},
				disconnectedWorkspace
			),
			{ composeServices: composeWithoutCredentials }
		);
		expect(jsonExitCode).toBe(1);
		expect(JSON.parse(jsonStdout.text) as Record<string, unknown>).toEqual({
			error: expect.stringContaining("Connect openai in Interactive Mode"),
		});
		expect(jsonStderr.text).toContain("Connect openai in Interactive Mode");
		expect(jsonStdout.text + jsonStderr.text).not.toContain(
			"fake-e2e-provider-key"
		);
	} finally {
		await fs.rm(disconnectedWorkspace, { force: true, recursive: true });
	}
});

test("headless Print fails closed when no ProviderCollection is available", async () => {
	const unavailableServices = composeServicesDetailedFor(
		registry,
		() => undefined
	);
	const initialProviderRequestCount = fakeRecorder.requests.length;
	const unavailableWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-headless-provider-unavailable-")
	);
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"do not dispatch without a ProviderCollection",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{},
				unavailableWorkspace
			),
			{ composeServices: unavailableServices }
		);
		expect(exitCode).toBe(1);
		expect(stderr.text).toContain("ProviderCollection is unavailable");
		expect(fakeRecorder.requests).toHaveLength(initialProviderRequestCount);
	} finally {
		await fs.rm(unavailableWorkspace, { force: true, recursive: true });
	}
});

test("one-shot rejects a disconnected model before creating a Session", async () => {
	const disconnectedWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-disconnected-model-")
	);
	const composeWithoutCredentials = composeServicesDetailedFor(
		registry,
		async () =>
			createInteractiveSessionProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => undefined,
					set: () => undefined,
				},
				modelStore: {
					get: () => undefined,
					set: () => undefined,
				},
			} satisfies InteractiveSessionProviderCollectionOptions)
	);
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"hello",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{ model: "anthropic/claude-sonnet-4-5" },
				disconnectedWorkspace
			),
			{ composeServices: composeWithoutCredentials }
		);

		expect(exitCode).toBe(1);
		expect(stderr.text).toContain("Connect anthropic");
		const verification = await composeServices({
			cwd: disconnectedWorkspace,
			workspace: disconnectedWorkspace,
		});
		try {
			expect(await verification.services.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await fs.rm(disconnectedWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot rejects restored ownerless Provider Models before constructing or reading Provider stores", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-ownerless-provider-")
	);
	const providerId = "one-shot-ownerless-provider";
	const selectedModelId = "ownerless-historical-model";
	const activity = {
		authorizations: 0,
		collections: 0,
		credentialReads: 0,
		discoveries: 0,
		modelReads: 0,
		providers: 0,
		streams: 0,
	};
	const providerModel: ProviderModel = {
		modelId: selectedModelId,
		protocolId: "fake-ownerless-provider",
		providerId,
	};
	const composeWithTrackedProvider = composeServicesDetailedFor(
		registry,
		() => {
			activity.collections += 1;
			const collection = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => {
						activity.credentialReads += 1;
						return { fake: true };
					},
					set: () => undefined,
				},
				modelStore: {
					get: () => {
						activity.modelReads += 1;
						return;
					},
					set: () => undefined,
				},
			});
			activity.providers += 1;
			const provider: Provider = {
				id: providerId,
				models: [providerModel],
				resolveAuthorization: () => {
					activity.authorizations += 1;
					return { authorization: { fake: true } };
				},
				discoverModels: () => {
					activity.discoveries += 1;
					return [];
				},
				async *streamChat(): AsyncGenerator<ProviderChatEvent> {
					activity.streams += 1;
					yield { type: "finish" };
				},
			};
			collection.register(provider);
			return collection;
		}
	);
	try {
		const freshStdout = writer();
		const freshStderr = writer();
		const freshExitCode = await runPrintMode(
			context(
				"print",
				"reject an ownerless explicit Provider before reserving a Session",
				freshStdout.writer,
				freshStderr.writer,
				undefined,
				undefined,
				true,
				{ model: `${providerId}/${selectedModelId}` },
				oneShotWorkspace
			),
			{ composeServices: composeWithTrackedProvider }
		);

		expect(freshExitCode).toBe(1);
		expect(freshStderr.text).toContain("re-select it in Interactive Mode");
		expect(freshStdout.text).toBe("");
		const sessionInspection = await composeWithTrackedProvider({
			cwd: oneShotWorkspace,
			workspace: oneShotWorkspace,
		});
		expect(await sessionInspection.services.store.listSessions()).toEqual([]);
		await sessionInspection.services.shutdown();

		const seeded = await composeWithTrackedProvider({
			cwd: oneShotWorkspace,
			workspace: oneShotWorkspace,
		});
		const { id: sessionId } = await seeded.services.store.createEmptySession({
			model: { modelId: toModelId(selectedModelId), providerId },
		});
		await seeded.services.shutdown();

		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"do not construct a Provider for historical ownerless identity",
				stdout.writer,
				stderr.writer,
				String(sessionId),
				undefined,
				true,
				{},
				oneShotWorkspace
			),
			{ composeServices: composeWithTrackedProvider }
		);

		expect(exitCode).toBe(1);
		expect(stderr.text).toContain("re-select it in Interactive Mode");
		expect(stdout.text).toBe("");
		expect(activity).toEqual({
			authorizations: 0,
			collections: 0,
			credentialReads: 0,
			discoveries: 0,
			modelReads: 0,
			providers: 0,
			streams: 0,
		});
	} finally {
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot rejects a Host Provider collection without the trusted snapshot before model restoration or admission", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-provider-owner-collision-")
	);
	const sourceIdentity = "/trusted/plugins/one-shot-collision.ts";
	const pluginRuntime = oneShotPluginRuntime(
		oneShotPluginRegistration(sourceIdentity, oneShotPluginRequests)
	);
	const activity = {
		availabilityCalls: 0,
		credentialReads: 0,
		discoveries: 0,
		modelStoreReads: 0,
		streams: 0,
	};
	const composeWithCollidingProvider = composeServicesDetailedFor(
		registry,
		() => {
			const collection = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => {
						activity.credentialReads += 1;
						return { fake: true };
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
				id: oneShotPluginProviderId,
				models: [oneShotPluginModel],
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
			return {
				...collection,
				getAvailable: async () => {
					activity.availabilityCalls += 1;
					return await getAvailable();
				},
			};
		}
	);
	const pluginDependencies: OneShotDependencies = {
		composeServices: (input) =>
			composeWithCollidingProvider({ ...input, pluginRuntime }),
	};
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"reject a generic Provider that collides with a trusted Plugin Provider",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{
					model: `${oneShotPluginProviderId}/${oneShotPluginModel.modelId}`,
				},
				oneShotWorkspace
			),
			pluginDependencies
		);

		expect(exitCode).toBe(1);
		expect(stdout.text).toBe("");
		expect(stderr.text).toContain(
			"Provider registrations do not match the current trusted registrations"
		);
		expect(activity).toEqual({
			availabilityCalls: 0,
			credentialReads: 0,
			discoveries: 0,
			modelStoreReads: 0,
			streams: 0,
		});
		const verification = await composeWithCollidingProvider({
			cwd: oneShotWorkspace,
			pluginRuntime,
			workspace: oneShotWorkspace,
		});
		try {
			expect(await verification.services.store.listSessions()).toEqual([]);
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await pluginRuntime.shutdown();
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot rejects a stale Host Plugin snapshot before reserving a built-in Session", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-provider-snapshot-mismatch-")
	);
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
	const staleRegistration: PluginProviderDescriptor = {
		connect: async () => {
			activity.connectCalls += 1;
		},
		createProvider: () => {
			throw new Error("The stale Plugin Provider must not be constructed.");
		},
		displayName: "Stale One-Shot Plugin Provider",
		pluginId: "stale-one-shot-plugin",
		providerId: "stale-one-shot-provider",
		sourceIdentity: "/trusted/plugins/stale-one-shot.ts",
		sourcePath: "/trusted/plugins/stale-one-shot.ts",
	};
	const collectionFactory: SessionServicesSources["createProviderCollection"] =
		() => {
			const collection = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => {
						activity.credentialReads += 1;
						return "fake-one-shot-key";
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
				id: sdkOneShotProviderModel.providerId,
				models: [sdkOneShotProviderModel],
				resolveAuthorization: () => {
					activity.credentialReads += 1;
					return { authorization: { fake: true } };
				},
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
		};
	let services: SessionServices | undefined;
	const compose = async (input: OneShotCompositionInput) => {
		const result = await composeServicesDetailedFor(
			registry,
			collectionFactory
		)(input);
		services = result.services;
		const externalizeAttachments = services.store.externalizeAttachments;
		services.store.externalizeAttachments = async (...args) => {
			activity.externalizations += 1;
			return externalizeAttachments(...args);
		};
		return result;
	};
	const stdout = writer();
	const stderr = writer();
	try {
		const exitCode = await runPrintMode(
			context(
				"print",
				"Do not reserve before the Host Plugin snapshot is verified.",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{},
				oneShotWorkspace
			),
			{ composeServices: compose }
		);
		expect(exitCode).toBe(1);
		expect(stdout.text).toBe("");
		expect(stderr.text).toContain(
			"Provider registrations do not match the current trusted registrations"
		);
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
		const verification = await openSessionServices({
			policy: {
				cwd: oneShotWorkspace,
				databasePath: path.join(oneShotWorkspace, "sessions.sqlite"),
				workspace: oneShotWorkspace,
			},
		});
		try {
			expect(await verification.store.listSessions()).toEqual([]);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await services?.shutdown();
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot binds a fresh explicit Plugin model to its current trusted source", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-plugin-owner-")
	);
	const sourceIdentity = "/trusted/plugins/one-shot-current.ts";
	const pluginRuntime = oneShotPluginRuntime(
		oneShotPluginRegistration(sourceIdentity, oneShotPluginRequests)
	);
	const composeWithPlugin = composeServicesDetailedFor(
		registry,
		oneShotPluginProviderCollectionFactory
	);
	const pluginDependencies: OneShotDependencies = {
		composeServices: (input) => composeWithPlugin({ ...input, pluginRuntime }),
	};
	oneShotPluginRequests.length = 0;
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"use the explicitly selected Plugin model",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{
					model: `${oneShotPluginProviderId}/${oneShotPluginModel.modelId}`,
				},
				oneShotWorkspace
			),
			pluginDependencies
		);

		expect(stderr.text).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout.text).toBe("Plugin response");
		expect(oneShotPluginRequests).toEqual([sourceIdentity]);
	} finally {
		await pluginRuntime.shutdown();
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot --agent overrides a restored model with its current trusted Plugin pin", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-plugin-agent-pin-")
	);
	const agentRegistration = oneShotPluginAgentRegistration();
	const registry = oneShotPluginAgentRegistry(agentRegistration);
	const sourceIdentity = "/trusted/plugins/one-shot-agent-current.ts";
	const pluginRuntime = oneShotPluginRuntime(
		oneShotPluginRegistration(sourceIdentity, oneShotPluginRequests),
		[agentRegistration]
	);
	const composeWithPlugin = composeServicesDetailedFor(
		registry,
		oneShotPluginProviderCollectionFactory
	);
	const pluginDependencies: OneShotDependencies = {
		composeServices: (input) => composeWithPlugin({ ...input, pluginRuntime }),
	};
	oneShotPluginRequests.length = 0;
	try {
		const seeded = await composeWithPlugin({
			cwd: oneShotWorkspace,
			pluginRuntime,
			workspace: oneShotWorkspace,
		});
		const { id: sessionId } = await seeded.services.store.createEmptySession({
			model: { modelId: toModelId("restored-model"), providerId: "openai" },
		});
		await seeded.services.shutdown();

		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"replace the restored model with the explicitly selected Agent pin",
				stdout.writer,
				stderr.writer,
				String(sessionId),
				undefined,
				true,
				{ agent: String(agentRegistration.agent.id) },
				oneShotWorkspace
			),
			pluginDependencies
		);

		expect(stderr.text).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout.text).toBe("Plugin response");
		expect(oneShotPluginRequests).toEqual([sourceIdentity]);
		const verification = await composeWithPlugin({
			cwd: oneShotWorkspace,
			pluginRuntime,
			workspace: oneShotWorkspace,
		});
		try {
			expect(
				await verification.services.store.getSession(sessionId)
			).toMatchObject({
				model: {
					modelId: oneShotPluginModel.modelId,
					pluginProviderSource: {
						pluginId: oneShotPluginId,
						sourceIdentity,
					},
					providerId: oneShotPluginProviderId,
				},
			});
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await pluginRuntime.shutdown();
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

for (const agentSourceKind of ["config", "builtin"] as const) {
	test(
		`One-Shot binds a fresh ${agentSourceKind} Agent pin to its unique trusted Provider owner`,
		async () => {
			const oneShotWorkspace = await fs.mkdtemp(
				path.join("/tmp", `wincode-one-shot-${agentSourceKind}-agent-pin-`)
			);
			const selectedAgent =
				agentSourceKind === "builtin" ? "build" : "configured-plugin-agent-pin";
			const agentRegistry =
				agentSourceKind === "builtin"
					? buildConfiguredAgentRegistry({
							build: {
								model: `${oneShotPluginProviderId}/${oneShotPluginModel.modelId}`,
							},
						})
					: buildConfiguredAgentRegistry({
							[selectedAgent]: {
								description: "Use the trusted custom Provider Model.",
								model: `${oneShotPluginProviderId}/${oneShotPluginModel.modelId}`,
								role: "primary",
							},
						});
			const sourceIdentity = `/trusted/plugins/one-shot-${agentSourceKind}-agent-pin.ts`;
			const pluginRuntime = oneShotPluginRuntime(
				oneShotPluginRegistration(sourceIdentity, oneShotPluginRequests)
			);
			const composeWithPlugin = composeServicesDetailedFor(
				agentRegistry,
				oneShotPluginProviderCollectionFactory
			);
			const pluginDependencies: OneShotDependencies = {
				composeServices: (input) =>
					composeWithPlugin({ ...input, pluginRuntime }),
			};
			oneShotPluginRequests.length = 0;
			try {
				const stdout = writer();
				const stderr = writer();
				const exitCode = await runPrintMode(
					context(
						"print",
						"use a current non-Markdown Agent's trusted custom Provider pin",
						stdout.writer,
						stderr.writer,
						undefined,
						undefined,
						true,
						{ agent: selectedAgent },
						oneShotWorkspace
					),
					pluginDependencies
				);

				expect(stderr.text).toBe("");
				expect(exitCode).toBe(0);
				expect(stdout.text).toBe("Plugin response");
				expect(oneShotPluginRequests).toEqual([sourceIdentity]);
			} finally {
				await pluginRuntime.shutdown();
				await fs.rm(oneShotWorkspace, { force: true, recursive: true });
			}
		},
		{ timeout: 15_000 }
	);
}

test("One-Shot rejects an ambiguous explicit Agent pin before Provider side effects", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-ambiguous-agent-owner-")
	);
	const selectedAgent = "ambiguous-explicit-agent-pin";
	const registry = buildConfiguredAgentRegistry({
		[selectedAgent]: {
			description: "Use the fake Plugin Provider Model.",
			model: `${oneShotPluginProviderId}/${oneShotPluginModel.modelId}`,
			role: "primary",
		},
	});
	const ownerSources = [
		"/trusted/plugins/one-shot-ambiguous-owner-a.ts",
		"/trusted/plugins/one-shot-ambiguous-owner-b.ts",
	];
	const pluginRuntime = createPluginRuntime(
		ownerSources.map((sourceIdentity, index) => {
			const pluginId = `one-shot-ambiguous-owner-${index}`;
			return {
				commands: [],
				id: pluginId,
				providers: [
					{
						...oneShotPluginRegistration(sourceIdentity, oneShotPluginRequests),
						pluginId,
					},
				],
				sourcePath: sourceIdentity,
				tools: [],
				workspace: oneShotWorkspace,
			};
		}),
		[]
	);
	let providerCollectionConstructions = 0;
	const trackedProviderCollection: SessionServicesSources["createProviderCollection"] =
		async (...args) => {
			providerCollectionConstructions += 1;
			return oneShotPluginProviderCollectionFactory(...args);
		};
	const composeWithPlugin = composeServicesDetailedFor(
		registry,
		trackedProviderCollection
	);
	oneShotPluginRequests.length = 0;
	try {
		const seeded = await composeWithPlugin({
			cwd: oneShotWorkspace,
			pluginRuntime,
			workspace: oneShotWorkspace,
		});
		const { id: sessionId } = await seeded.services.store.createEmptySession({
			model: { modelId: toModelId("restored-model"), providerId: "openai" },
		});
		await seeded.services.shutdown();

		const stdout = writer();
		const stderr = writer();
		const pluginDependencies: OneShotDependencies = {
			composeServices: (input) =>
				composeWithPlugin({ ...input, pluginRuntime }),
		};
		const exitCode = await runPrintMode(
			context(
				"print",
				"reject an Agent pin with ambiguous Plugin ownership",
				stdout.writer,
				stderr.writer,
				String(sessionId),
				undefined,
				true,
				{ agent: selectedAgent },
				oneShotWorkspace
			),
			pluginDependencies
		);

		expect(exitCode).toBe(1);
		expect(stderr.text).toContain("re-select it in Interactive Mode");
		expect(stdout.text).toBe("");
		expect(providerCollectionConstructions).toBe(0);
		expect(oneShotPluginRequests).toEqual([]);
	} finally {
		await pluginRuntime.shutdown();
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot keeps restored Plugin ownership strict until an Agent is explicitly reselected", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-restored-plugin-agent-")
	);
	const agentRegistration = oneShotPluginAgentRegistration();
	const registry = oneShotPluginAgentRegistry(agentRegistration);
	const oldSourceIdentity = "/trusted/plugins/one-shot-old.ts";
	const newSourceIdentity = "/trusted/plugins/one-shot-new.ts";
	const oldRuntime = oneShotPluginRuntime(
		oneShotPluginRegistration(oldSourceIdentity, oneShotPluginRequests),
		[agentRegistration]
	);
	const currentRuntime = oneShotPluginRuntime(
		oneShotPluginRegistration(newSourceIdentity, oneShotPluginRequests),
		[agentRegistration]
	);
	const composeWithPlugin = composeServicesDetailedFor(
		registry,
		oneShotPluginProviderCollectionFactory
	);
	oneShotPluginRequests.length = 0;
	try {
		const seeded = await composeWithPlugin({
			cwd: oneShotWorkspace,
			pluginRuntime: oldRuntime,
			workspace: oneShotWorkspace,
		});
		const { id: sessionId } = await seeded.services.store.createEmptySession({
			model: {
				modelId: toModelId(oneShotPluginModel.modelId),
				pluginProviderSource: {
					pluginId: oneShotPluginId,
					sourceIdentity: oldSourceIdentity,
				},
				providerId: oneShotPluginProviderId,
			},
		});
		await seeded.services.shutdown();

		const pluginDependencies: OneShotDependencies = {
			composeServices: (input) =>
				composeWithPlugin({ ...input, pluginRuntime: currentRuntime }),
		};
		const implicitStdout = writer();
		const implicitStderr = writer();
		const implicitExitCode = await runPrintMode(
			context(
				"print",
				"do not infer the new Plugin source for saved history",
				implicitStdout.writer,
				implicitStderr.writer,
				String(sessionId),
				undefined,
				true,
				{},
				oneShotWorkspace
			),
			pluginDependencies
		);
		expect(implicitExitCode).toBe(1);
		expect(implicitStdout.text).toBe("");
		expect(implicitStderr.text.startsWith("error:")).toBe(true);
		expect(oneShotPluginRequests).toEqual([]);

		const reselectionStdout = writer();
		const reselectionStderr = writer();
		const reselectionExitCode = await runPrintMode(
			context(
				"print",
				"reselect the current trusted Plugin Agent pin",
				reselectionStdout.writer,
				reselectionStderr.writer,
				String(sessionId),
				undefined,
				true,
				{ agent: String(agentRegistration.agent.id) },
				oneShotWorkspace
			),
			pluginDependencies
		);
		expect(reselectionExitCode).toBe(0);
		expect(reselectionStderr.text).toBe("");
		expect(reselectionStdout.text).toBe("Plugin response");
		expect(oneShotPluginRequests).toEqual([newSourceIdentity]);
	} finally {
		await Promise.all([oldRuntime.shutdown(), currentRuntime.shutdown()]);
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("one-shot replaces unavailable SDK Agent pins only with exact Host models", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-sdk-model-")
	);
	const sdkRecorder = createFakeProviderRecorder();
	const availabilityProviderIds: string[] = [];
	const unrelatedProviderModel: ProviderModel = {
		modelId: "unrelated-one-shot-model",
		protocolId: "fake-e2e-provider",
		providerId: "unrelated-one-shot-provider",
	};
	let providerCollectionCreations = 0;
	const composeSdkOneShot = composeServicesDetailedFor(
		sdkPinnedOneShotRegistry,
		() => {
			providerCollectionCreations += 1;
			const collection = createFakeProviderCollection(
				sdkRecorder,
				sdkOneShotProviderModel,
				[unrelatedProviderModel]
			);
			const getAvailable = collection.getAvailable.bind(collection);
			return {
				...collection,
				getAvailable: async (providerId) => {
					availabilityProviderIds.push(providerId ?? "<all>");
					return getAvailable(providerId);
				},
			};
		}
	);
	try {
		const stdout = writer();
		const stderr = writer();
		const oneShotContext = context(
			"print",
			"use the active SDK Model",
			stdout.writer,
			stderr.writer,
			undefined,
			undefined,
			true,
			{
				agent: "review",
				model: "openai/one-shot-model-v2",
				thinkingLevel: "high",
			},
			oneShotWorkspace
		);
		const exitCode = await runPrintMode(oneShotContext, {
			composeServices: composeSdkOneShot,
		});
		expect(providerCollectionCreations).toBe(1);
		expect(stderr.text).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout.text).toBe("E2E chat response");
		expect(stderr.text).toBe("");
		expect(
			sdkRecorder.requests.filter(({ kind }) => kind === "chat")
		).toHaveLength(1);
		expect(availabilityProviderIds.length).toBeGreaterThan(0);
		expect(new Set(availabilityProviderIds)).toEqual(new Set(["openai"]));
		const verification = await composeSdkOneShot({
			cwd: oneShotWorkspace,
			workspace: oneShotWorkspace,
		});
		try {
			const sessions = await verification.services.store.listSessions();
			expect(sessions).toHaveLength(1);
			expect(String(sessions[0]?.model?.modelId)).toBe("one-shot-model-v2");
			expect(sessions[0]?.model?.providerId).toBe("openai");
			expect(sessions[0]?.thinkingLevel).toBe("high");
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await fs.rm(oneShotWorkspace, { force: true, recursive: true });
	}
});

test("one-shot fails closed for an SDK Model the Host does not provide", async () => {
	const unavailableWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-sdk-unavailable-")
	);
	const sdkRecorder = createFakeProviderRecorder();
	const composeSdkOneShot = composeServicesDetailedFor(registry, () =>
		createFakeProviderCollection(sdkRecorder, sdkOneShotProviderModel)
	);
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"request an unavailable SDK Model",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{ model: "openai/missing-model-v1" },
				unavailableWorkspace
			),
			{ composeServices: composeSdkOneShot }
		);
		expect(exitCode).toBe(1);
		expect(stdout.text).toBe("");
		expect(stderr.text).toContain("unavailable in this One-Shot Host");
		expect(
			sdkRecorder.requests.filter(({ kind }) => kind === "chat")
		).toHaveLength(0);
		const verification = await composeSdkOneShot({
			cwd: unavailableWorkspace,
			workspace: unavailableWorkspace,
		});
		try {
			expect(await verification.services.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await fs.rm(unavailableWorkspace, { force: true, recursive: true });
	}
});

test("One-Shot checks fresh model availability before creating its durable Session row", async () => {
	const unavailableWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-preflight-before-row-")
	);
	const sdkRecorder = createFakeProviderRecorder();
	let servicesDuringAvailability: SessionServices | undefined;
	let sessionRowsDuringAvailability: number | undefined;
	const composeBase = composeServicesDetailedFor(registry, () => {
		const collection = createFakeProviderCollection(
			sdkRecorder,
			sdkOneShotProviderModel
		);
		const getAvailable = collection.getAvailable.bind(collection);
		return Object.assign(collection, {
			getAvailable: async () => {
				if (servicesDuringAvailability !== undefined) {
					sessionRowsDuringAvailability = (
						await servicesDuringAvailability.store.listSessions()
					).length;
				}
				return await getAvailable();
			},
		});
	});
	const composeSdkOneShot = async (input: OneShotCompositionInput) => {
		const composition = await composeBase(input);
		servicesDuringAvailability = composition.services;
		return composition;
	};
	try {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runPrintMode(
			context(
				"print",
				"request an unavailable SDK Model",
				stdout.writer,
				stderr.writer,
				undefined,
				undefined,
				true,
				{ model: "openai/missing-model-v1" },
				unavailableWorkspace
			),
			{ composeServices: composeSdkOneShot }
		);
		expect(exitCode).toBe(1);
		expect(sessionRowsDuringAvailability).toBe(0);
		expect(stdout.text).toBe("");
		expect(stderr.text).toContain("unavailable in this One-Shot Host");
		expect(
			sdkRecorder.requests.filter(({ kind }) => kind === "chat")
		).toHaveLength(0);
		const verification = await composeBase({
			cwd: unavailableWorkspace,
			workspace: unavailableWorkspace,
		});
		try {
			expect(await verification.services.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.services.shutdown();
		}
	} finally {
		await fs.rm(unavailableWorkspace, { force: true, recursive: true });
	}
});

test("one-shot input rejects simultaneous prompt and stdin", async () => {
	const stdout = writer();
	const stderr = writer();
	const stdin = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode("stdin text");
	})();
	const exitCode = await runPrintMode(
		context(
			"print",
			"prompt text",
			stdout.writer,
			stderr.writer,
			undefined,
			stdin,
			false
		),
		noCapabilities
	);

	expect(exitCode).toBe(1);
	expect(stderr.text).toContain("not both");
});
test("JSON mode reports runtime failures as JSONL", async () => {
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runJsonMode(
		context("json", "runtime failure", stdout.writer, stderr.writer),
		noCapabilities
	);

	expect(exitCode).toBe(1);
	expect(stdout.text.trim().split("\n")).toHaveLength(1);
	expect(JSON.parse(stdout.text) as Record<string, unknown>).toEqual({
		error: "capabilities should not be composed",
	});
	expect(stderr.text).toContain("capabilities should not be composed");
});

const noCapabilities: OneShotDependencies = {
	composeServices: async () => {
		throw new Error("capabilities should not be composed");
	},
};

test("one-shot keeps Print parent-only and tags JSON child Session events", async () => {
	const printWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-delegation-print-")
	);
	const jsonWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-delegation-json-")
	);
	const delegatedRegistry = buildConfiguredAgentRegistry({
		scout: {
			description: "Inspect work and report findings.",
			role: "subagent",
		},
	});
	const composeDelegated = composeServicesDetailedFor(delegatedRegistry);
	const dependencies: OneShotDependencies = {
		composeServices: async (input) => composeDelegated(input),
	};
	const previousScript = fakeRecorder.stepScript;
	let callSequence = 0;
	const script: FakeProviderStepScript = async function* (
		request: ProviderChatRequest
	): AsyncGenerator<ProviderChatEvent> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		const hasToolResult = request.messages.some(
			({ content, role }) =>
				role === "tool" || content.some((part) => part.type === "tool-result")
		);
		if (latestUserText === "Inspect one-shot child work.") {
			yield { delta: "Child internal output.", type: "text-delta" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
			return;
		}
		if (hasToolResult) {
			yield { delta: "Parent-only result.", type: "text-delta" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
			return;
		}
		callSequence += 1;
		yield {
			input: {
				agent: "scout",
				prompt: "Inspect one-shot child work.",
			},
			toolCallId: `one-shot-delegate-${callSequence}`,
			toolName: "delegate",
			type: "tool-call",
		};
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	fakeRecorder.stepScript = script;
	try {
		const printStdout = writer();
		const printStderr = writer();
		const printExitCode = await withTrustedWorktreePlugins(() =>
			runPrintMode(
				context(
					"print",
					"Delegate work to scout.",
					printStdout.writer,
					printStderr.writer,
					undefined,
					undefined,
					true,
					{},
					printWorkspace
				),
				dependencies
			)
		);
		expect(printExitCode).toBe(1);
		expect(printStdout.text).toBe("Parent-only result.");
		expect(printStdout.text).not.toContain("Child internal output.");
		expect(printStderr.text).toContain("awaiting_report");
		expect(printStderr.text).toContain(
			"will not continue the parent Session automatically"
		);

		const jsonStdout = writer();
		const jsonStderr = writer();
		const jsonExitCode = await withTrustedWorktreePlugins(() =>
			runJsonMode(
				context(
					"json",
					"Delegate work to scout.",
					jsonStdout.writer,
					jsonStderr.writer,
					undefined,
					undefined,
					true,
					{},
					jsonWorkspace
				),
				dependencies
			)
		);
		const events = jsonStdout.text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(jsonExitCode).toBe(1);
		expect(jsonStdout.text).toContain("Parent-only result.");
		expect(jsonStdout.text).toContain("Child internal output.");
		expect(
			events.some(
				({ type, delta, sessionId }) =>
					type === "text-delta" &&
					delta === "Child internal output." &&
					typeof sessionId === "string"
			)
		).toBe(true);
		expect(
			events.some(
				({ type, sessionId }) =>
					type === "agent-turn-completed" && typeof sessionId === "string"
			)
		).toBe(true);
		const parentTextDeltas = events
			.filter(
				({ type, sessionId }) =>
					type === "text-delta" && sessionId === undefined
			)
			.map(({ delta }) => delta);
		expect(parentTextDeltas).toContain("Parent-only result.");
		expect(parentTextDeltas).not.toContain("Child internal output.");
		expect(jsonStderr.text).toContain("awaiting_report");
		expect(jsonStderr.text).toContain(
			"will not continue the parent Session automatically"
		);
	} finally {
		fakeRecorder.stepScript = previousScript;
		await Promise.all([
			fs.rm(printWorkspace, { force: true, recursive: true }),
			fs.rm(jsonWorkspace, { force: true, recursive: true }),
		]);
	}
});
