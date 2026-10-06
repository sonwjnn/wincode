import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema, createAgentRuntime } from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
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
import { createPermissionService } from "../modules/permissions/permission-service";
import type { SessionCapabilitiesAssembly } from "../modules/sessions/host/session-capabilities";
import { createSessionCapabilities } from "../modules/sessions/host/session-capabilities";
import { createSessionHost } from "../modules/sessions/host/session-host";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
	type FakeModelStepScript,
} from "./support/e2e-fake-runtime";

const fakeRecorder = createFakeModelClientRecorder();
const fakeRuntime = createAgentRuntime({
	modelClient: createFakeModelClient(fakeRecorder),
});

const workspace = await mkdtemp(path.join("/tmp", "wincode-one-shot-"));
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
		effort: "high",
		model: "openai/gpt-5.6-luna",
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

const composeCapabilitiesFor =
	(agentRegistry: AgentRegistry) =>
	async ({
		autoApproval,
		cwd,
		workspace: root,
		enabledPlugins = ["mcp", "subagents"],
	}: OneShotCompositionInput): Promise<SessionCapabilitiesAssembly> => {
		const composition = createApplicationPluginComposition({
			createMcpResource: false,
			enabledPlugins,
			workspace: root,
		});
		return createSessionCapabilities({
			approvalMode: "non-interactive",
			cwd,
			databasePath: path.join(root, "sessions.sqlite"),
			permissionService: createPermissionService({ autoApproval }),
			registry: agentRegistry,
			runtimeFactory: () => fakeRuntime,
			...(composition.createDelegationAdapter === undefined
				? {}
				: { createDelegationAdapter: composition.createDelegationAdapter }),
			...(composition.createDelegationRuntime === undefined
				? {}
				: { createDelegationRuntime: composition.createDelegationRuntime }),
			turnToolResolver: composition.turnToolResolver,
			workspace: root,
			connections,
		});
	};
const composeCapabilities = composeCapabilitiesFor(registry);
const composeConfiguredReview = composeCapabilitiesFor(
	configuredReviewRegistry
);

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
	effort?: string;
	model?: string;
	reasoningMode?: string;
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
		auto: false,
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

const dependencies: OneShotDependencies = { composeCapabilities };
const configuredReviewDependencies: OneShotDependencies = {
	composeCapabilities: composeConfiguredReview,
};

test("configured Agents retain model-supported Effort and Reasoning Mode choices", () => {
	const configured = buildConfiguredAgentRegistry({
		"effort-review": {
			description: "Review with a selected Effort.",
			effort: "high",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
		},
		"mode-review": {
			description: "Review with a selected Reasoning Mode.",
			model: "anthropic/claude-sonnet-5",
			reasoningMode: "none",
			role: "primary",
		},
	});

	expect(configured.configuredAgents).toHaveLength(2);
	expect(
		configured.configuredAgents.find(({ id }) => id === "effort-review")
	).toMatchObject({
		effort: "high",
		model: { modelId: "claude-sonnet-5", providerId: "anthropic" },
	});
	expect(
		configured.configuredAgents.find(({ id }) => id === "mode-review")
	).toMatchObject({
		model: { modelId: "claude-sonnet-5", providerId: "anthropic" },
		reasoningMode: "none",
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

test("configured Agents reject unsupported, conflicting, invalid, and legacy choices by field", () => {
	const configured = buildConfiguredAgentRegistry({
		both: {
			description: "Two choices are not valid.",
			effort: "high",
			model: "anthropic/claude-sonnet-5",
			reasoningMode: "none",
			role: "primary",
		},
		legacy: {
			description: "The old key is not valid.",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
			variant: "high",
		},
		"unsupported-effort": {
			description: "This model has no selectable Effort.",
			effort: "low",
			model: "opencode-go/qwen3.7-max",
			role: "primary",
		},
		"unsupported-mode": {
			description: "This model has no selectable Reasoning Mode.",
			model: "openai/gpt-5.6-luna",
			reasoningMode: "thinking",
			role: "primary",
		},
		"invalid-effort": {
			description: "Efforts must be valid identifiers.",
			effort: "extreme",
			model: "anthropic/claude-sonnet-5",
			role: "primary",
		},
		"invalid-mode": {
			description: "Reasoning Modes must be valid identifiers.",
			model: "anthropic/claude-sonnet-5",
			reasoningMode: "deliberate",
			role: "primary",
		},
	});

	expect(configured.configuredAgents).toHaveLength(0);
	for (const [agentId, field] of [
		["both", "reasoningMode"],
		["legacy", "variant"],
		["unsupported-effort", "effort"],
		["unsupported-mode", "reasoningMode"],
		["invalid-effort", "effort"],
		["invalid-mode", "reasoningMode"],
	] as const) {
		expect(configured.diagnostics).toContainEqual(
			expect.objectContaining({
				configPath: ["agents", agentId, field],
				severity: "error",
			})
		);
	}
	expect(
		configured.diagnostics.find(
			({ configPath }) =>
				configPath[1] === "unsupported-effort" && configPath[2] === "effort"
		)?.message
	).toContain('"effort"');
	expect(
		configured.diagnostics.find(
			({ configPath }) => configPath[1] === "unsupported-mode"
		)?.message
	).toContain('"reasoningMode"');
});

afterAll(async () => {
	await rm(workspace, { force: true, recursive: true });
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
	const verification = await createSessionCapabilities({
		approvalMode: "non-interactive",
		cwd: workspace,
		databasePath: path.join(workspace, "sessions.sqlite"),
		permissionService: createPermissionService(),
		registry,
		workspace,
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
	const finalVerification = await composeCapabilities({
		autoApproval: false,
		cwd: workspace,
		workspace,
	});
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

test("one-shot Effort selectors override configured and restored choices", async () => {
	const reasoningWorkspace = await mkdtemp(
		path.join("/tmp", "wincode-one-shot-effort-")
	);
	try {
		const initialOutput = writer();
		const initialErrors = writer();
		const initialExitCode = await runPrintMode(
			context(
				"print",
				"choose a configured Agent Effort",
				initialOutput.writer,
				initialErrors.writer,
				undefined,
				undefined,
				true,
				{ agent: "review", effort: "medium" },
				reasoningWorkspace
			),
			configuredReviewDependencies
		);
		expect(initialExitCode).toBe(0);
		expect(initialOutput.text).toBe("E2E chat response");
		expect(initialErrors.text).toBe("");
		const firstVerification = await composeConfiguredReview({
			autoApproval: false,
			cwd: reasoningWorkspace,
			workspace: reasoningWorkspace,
		});
		let sessionId: string | undefined;
		try {
			const sessions = await firstVerification.store.listSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.effort).toBe("medium");
			sessionId = sessions[0]?.id;
		} finally {
			await firstVerification.shutdown();
		}
		if (sessionId === undefined) {
			throw new Error(
				"Expected the selected Effort to persist in the Session."
			);
		}

		const continuationOutput = writer();
		const continuationErrors = writer();
		const continuationExitCode = await runPrintMode(
			context(
				"print",
				"override the restored Effort",
				continuationOutput.writer,
				continuationErrors.writer,
				sessionId,
				undefined,
				true,
				{ agent: "review", effort: "low" },
				reasoningWorkspace
			),
			configuredReviewDependencies
		);
		expect(continuationExitCode).toBe(0);
		expect(continuationOutput.text).toBe("E2E chat response");
		expect(continuationErrors.text).toBe("");
		const finalVerification = await composeConfiguredReview({
			autoApproval: false,
			cwd: reasoningWorkspace,
			workspace: reasoningWorkspace,
		});
		try {
			const sessions = await finalVerification.store.listSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.effort).toBe("low");
		} finally {
			await finalVerification.shutdown();
		}
	} finally {
		await rm(reasoningWorkspace, { force: true, recursive: true });
	}
});

test("one-shot invalid explicit choices name their field and fail before send", async () => {
	const invalidWorkspace = await mkdtemp(
		path.join("/tmp", "wincode-invalid-reasoning-choice-")
	);
	try {
		const invalidChoices: readonly {
			readonly field: string;
			readonly selectors: SelectorOptions;
		}[] = [
			{ field: "--effort", selectors: { effort: "extreme" } },
			{
				field: "--reasoning-mode",
				selectors: { reasoningMode: "thinking" },
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
					"invalid reasoning selector",
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
		const verification = await composeCapabilities({
			autoApproval: false,
			cwd: invalidWorkspace,
			workspace: invalidWorkspace,
		});
		try {
			expect(await verification.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await rm(invalidWorkspace, { force: true, recursive: true });
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

	const lookup = await createSessionCapabilities({
		approvalMode: "non-interactive",
		cwd: workspace,
		databasePath: path.join(workspace, "sessions.sqlite"),
		permissionService: createPermissionService(),
		registry,
		workspace,
	});
	const sessions = await lookup.store.listSessions();
	const sessionId = sessions.at(-1)?.id;
	await lookup.shutdown();
	if (sessionId === undefined) {
		throw new Error("Expected a seeded Session for the writer conflict test.");
	}

	const holderAssembly = await composeCapabilities({
		autoApproval: false,
		cwd: workspace,
		workspace,
	});
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
	const emptyWorkspace = await mkdtemp(
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
		const verification = await composeCapabilities({
			autoApproval: false,
			cwd: emptyWorkspace,
			workspace: emptyWorkspace,
		});
		try {
			expect(await verification.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await rm(emptyWorkspace, { force: true, recursive: true });
	}
});

test("one-shot rejects a disconnected model before creating a Session", async () => {
	const disconnectedWorkspace = await mkdtemp(
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
		const verification = await composeCapabilities({
			autoApproval: false,
			cwd: disconnectedWorkspace,
			workspace: disconnectedWorkspace,
		});
		try {
			expect(await verification.store.listSessions()).toHaveLength(0);
		} finally {
			await verification.shutdown();
		}
	} finally {
		await rm(disconnectedWorkspace, { force: true, recursive: true });
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
	composeCapabilities: async () => {
		throw new Error("capabilities should not be composed");
	},
};

test("one-shot waits for delegated outcomes, tags JSON child events, and keeps Print output parent-only", async () => {
	const printWorkspace = await mkdtemp(
		path.join("/tmp", "wincode-one-shot-delegation-print-")
	);
	const jsonWorkspace = await mkdtemp(
		path.join("/tmp", "wincode-one-shot-delegation-json-")
	);
	const delegatedRegistry = buildConfiguredAgentRegistry({
		scout: {
			description: "Inspect work and report findings.",
			role: "subagent",
		},
	});
	const composeDelegated = composeCapabilitiesFor(delegatedRegistry);
	const dependencies: OneShotDependencies = {
		composeCapabilities: async (input) => composeDelegated(input),
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
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "delegated-agent-turn-event",
					event: expect.objectContaining({
						delta: "Child internal output.",
						type: "text-delta",
					}),
				}),
				expect.objectContaining({
					type: "delegation-task",
					task: expect.objectContaining({ status: "awaiting_report" }),
				}),
			])
		);
		expect(jsonStderr.text).toContain("awaiting_report");
		expect(jsonStderr.text).toContain(
			"will not continue the parent Session automatically"
		);
	} finally {
		fakeRecorder.stepScript = previousScript;
		await Promise.all([
			rm(printWorkspace, { force: true, recursive: true }),
			rm(jsonWorkspace, { force: true, recursive: true }),
		]);
	}
});
