import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: AGENTS.md requires namespace imports for node modules.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: AGENTS.md requires namespace imports for node modules.
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { createAgentRuntime } from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import { buildAgentRegistry } from "../modules/agents/registry";
import {
	type OneShotCompositionInput,
	type OneShotDependencies,
	runPrintMode,
} from "../modules/application/modes/one-shot";
import type {
	ApplicationContext,
	TextWriter,
} from "../modules/application/modes/types";
import { createPermissionService } from "../modules/permissions/permission-service";
import type { SessionCapabilitiesAssembly } from "../modules/sessions/host/session-capabilities";
import { createSessionCapabilities } from "../modules/sessions/host/session-capabilities";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
	type FakeModelStepScript,
} from "./support/e2e-fake-runtime";
import { toolCallId } from "./support/identifiers";

const workspace = await mkdtemp(
	path.join(os.tmpdir(), "wincode-mode-approval-")
);
await globalThis.Bun.write(
	path.join(workspace, ".env"),
	"SECRET=not-for-agents\n"
);
let approvalErrorText = "";
const recorder = createFakeModelClientRecorder();
const approvalScript: FakeModelStepScript = async function* (
	request: ModelStepRequest
): AsyncGenerator<ModelStreamPart> {
	const failure = request.messages
		.flatMap((message) => message.content)
		.find((part) => part.type === "tool-failure");
	if (failure?.type === "tool-failure") {
		approvalErrorText = failure.errorText;
		throw new Error(approvalErrorText);
	}
	yield {
		input: { path: ".env" },
		toolCallId: toolCallId("noninteractive-read"),
		toolName: "read",
		type: "tool-call",
	};
	yield {
		type: "finish",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
};
const fakeRuntime = createAgentRuntime({
	modelClient: createFakeModelClient(recorder, approvalScript),
});
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

type CapturedOutput = {
	readonly text: string;
	readonly writer: TextWriter;
};

const output = (): CapturedOutput => {
	let text = "";
	return {
		get text() {
			return text;
		},
		writer: {
			write: (chunk: string): void => {
				text += chunk;
			},
		},
	};
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

const context = (
	stdout: TextWriter,
	stderr: TextWriter
): ApplicationContext => ({
	args: [],
	cwd: workspace,
	invocation: { auto: false, mode: "print", prompt: "read the env file" },
	stderr,
	stdin: (async function* (): AsyncGenerator<Uint8Array> {
		yield* [];
	})(),
	stdinIsTTY: true,
	stdout,
});

const dependencies: OneShotDependencies = { composeCapabilities };

afterAll(async () => {
	await rm(workspace, { force: true, recursive: true });
});

test("Print mode fails closed when an approval ask has no UI", async () => {
	const stdout = output();
	const stderr = output();
	const exitCode = await runPrintMode(
		context(stdout.writer, stderr.writer),
		dependencies
	);

	expect(exitCode).toBe(1);
	expect(stdout.text).toBe("");
	expect(approvalErrorText).toContain("Interactive approval is unavailable");
});
