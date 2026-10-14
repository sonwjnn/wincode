import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema, createAgentRuntime } from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import type { ProviderModel } from "@wincode/ai/sdk";
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
import { createSessionHost } from "../modules/sessions/host/session-host";
import {
	openSessionServices,
	type SessionServicesSources,
} from "../modules/sessions/host/session-services";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
	createFakeProviderCollection,
	type FakeModelStepScript,
} from "./support/e2e-fake-runtime";

const fakeRecorder = createFakeModelClientRecorder();
const fakeRuntime = createAgentRuntime({
	modelClient: createFakeModelClient(fakeRecorder),
});

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
	providerId: "fake-one-shot",
	protocolId: "fake-e2e-model-client",
	reasoningEfforts: ["high"],
};
const sdkPinnedOneShotRegistry = buildConfiguredAgentRegistry({
	review: {
		description: "Review with an unavailable SDK Model pin.",
		model: "fake-one-shot/old-model-v1",
		role: "primary",
	},
});

const connections = {
	authorize: async () => ({ kind: "api-key" as const, apiKey: "test-key" }),
	connect: async () => undefined,
	listProviders: async () => [
		{
			connected: true as const,
			connectionMethod: "api-key" as const,
			displayName: "OpenAI",
			id: "openai" as const,
			methods: ["api-key", "browser"] as const,
		},
	],
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
				connections: () => connections,
				registry: () => agentRegistry,
				...(createProviderCollection === undefined
					? { runtimeFactory: () => fakeRuntime }
					: { createProviderCollection }),
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

test("configured Agents reject unsupported, invalid, and legacy ThinkingLevel choices", () => {
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

	expect(configured.configuredAgents).toHaveLength(0);
	for (const [agentId, field] of [
		["legacy-effort", "effort"],
		["legacy-mode", "reasoningMode"],
		["legacy-variant", "variant"],
		["unsupported-level", "thinking_level"],
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

test("built-in Agent patches reject unsupported ThinkingLevels", () => {
	const configured = buildConfiguredAgentRegistry({
		build: {
			model: "opencode-go/grok-4.6",
			thinking_level: "low",
		},
	});
	const build = configured.agents.find(({ id }) => id === "build");

	expect(build).not.toHaveProperty("thinkingLevel");
	expect(configured.diagnostics).toContainEqual(
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

test("one-shot rejects a disconnected model before creating a Session", async () => {
	const disconnectedWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-disconnected-model-")
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
			dependencies
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

test("one-shot replaces unavailable SDK Agent pins only with exact Host models", async () => {
	const oneShotWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-one-shot-sdk-model-")
	);
	const sdkRecorder = createFakeModelClientRecorder();
	let providerCollectionCreations = 0;
	const composeSdkOneShot = composeServicesDetailedFor(
		sdkPinnedOneShotRegistry,
		() => {
			providerCollectionCreations += 1;
			return createFakeProviderCollection(sdkRecorder, sdkOneShotProviderModel);
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
				model: "fake-one-shot/one-shot-model-v2",
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
		const verification = await composeSdkOneShot({
			cwd: oneShotWorkspace,
			workspace: oneShotWorkspace,
		});
		try {
			const sessions = await verification.services.store.listSessions();
			expect(sessions).toHaveLength(1);
			expect(String(sessions[0]?.model?.modelId)).toBe("one-shot-model-v2");
			expect(sessions[0]?.model?.providerId).toBe("fake-one-shot");
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
	const sdkRecorder = createFakeModelClientRecorder();
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
				{ model: "fake-one-shot/missing-model-v1" },
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
	const script: FakeModelStepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		const hasToolResult = request.messages.some(({ role }) => role === "tool");
		if (latestUserText === "Inspect one-shot child work.") {
			yield { delta: "Child internal output.", type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (hasToolResult) {
			yield { delta: "Parent-only result.", type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
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
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
	};
	fakeRecorder.stepScript = script;
	try {
		const printStdout = writer();
		const printStderr = writer();
		const printExitCode = await runPrintMode(
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
		const jsonExitCode = await runJsonMode(
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
