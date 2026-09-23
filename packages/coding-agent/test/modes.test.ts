import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: AGENTS.md requires namespace imports for node modules.
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema } from "@wincode/agent-core";
import { buildAgentRegistry } from "../modules/agents/registry";
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
import { createPermissionService } from "../modules/permissions/permission-service";
import type { SessionCapabilitiesAssembly } from "../modules/sessions/host/session-capabilities";
import { createSessionCapabilities } from "../modules/sessions/host/session-capabilities";
import { createSessionHost } from "../modules/sessions/host/session-host";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
} from "./support/e2e-fake-runtime";

const fakeRecorder = createFakeAiSdkRecorder();
const fakeRuntime =
	createFakeAiSdkModule(fakeRecorder).createAiSdkAgentRuntime();

const workspace = await mkdtemp(path.join("/tmp", "wincode-one-shot-"));
const registry = buildAgentRegistry(
	fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {},
		sourceFor: () => undefined,
		sources: [],
	})
);

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

const composeCapabilities = async ({
	autoApproval,
	cwd,
	workspace: root,
}: OneShotCompositionInput): Promise<SessionCapabilitiesAssembly> =>
	createSessionCapabilities({
		approvalMode: "non-interactive",
		cwd,
		databasePath: path.join(root, "sessions.sqlite"),
		permissionService: createPermissionService({ autoApproval }),
		registry,
		runtimeFactory: () => fakeRuntime,
		workspace: root,
		connections,
	});

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
	thinking?: string;
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
			{ agent: "plan" }
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
		expect(records.at(-1)?.agentId).toBe(agentIdSchema.parse("plan"));
	} finally {
		await finalVerification.shutdown();
	}
});

test("Print mode reports an existing Session Lease conflict", async () => {
	const seed = writer();
	const seedErrors = writer();
	expect(
		await runPrintMode(
			context(
				"print",
				"seed the lease conflict session",
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
		throw new Error("Expected a seeded Session for the lease conflict test.");
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
