import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: AGENTS.md requires namespace imports for node modules.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: AGENTS.md requires namespace imports for node modules.
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentTurnEvent } from "@wincode/agent-core";
import type {
	OneShotCompositionInput,
	OneShotDependencies,
} from "../modules/application/modes/one-shot";
import type {
	ApplicationContext,
	TextWriter,
} from "../modules/application/modes/types";
import type { SessionCapabilitiesAssembly } from "../modules/sessions/host/session-capabilities";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
	type FakeTurnScript,
} from "./support/e2e-fake-runtime";
import { modelStepId, toolCallId } from "./support/identifiers";

const workspace = await mkdtemp(
	path.join(os.tmpdir(), "wincode-mode-approval-")
);
await writeFile(path.join(workspace, ".env"), "SECRET=not-for-agents\n");
let approvalErrorText = "";
const recorder = createFakeAiSdkRecorder();
const approvalScript: FakeTurnScript = async function* (
	turn
): AsyncGenerator<AgentTurnEvent> {
	const read = turn.tools?.find(({ definition }) => definition.name === "read");
	if (read === undefined) {
		approvalErrorText = "The turn was not armed with the read Tool.";
		throw new Error(approvalErrorText);
	}
	const callId = toolCallId("noninteractive-read");
	const stepId = modelStepId("noninteractive-step");
	yield {
		agentId: turn.agent.id,
		sequence: 0,
		startedAt: 1,
		turnId: turn.id,
		type: "agent-turn-started",
	};
	yield {
		modelId: turn.model.modelId,
		sequence: 1,
		stepId,
		turnId: turn.id,
		type: "model-step-started",
	};
	yield {
		input: { path: ".env" },
		sequence: 2,
		toolCallId: callId,
		toolName: "read",
		turnId: turn.id,
		type: "tool-call-started",
	};
	try {
		const outcome = await read.execute(
			{ input: { path: ".env" }, toolCallId: callId },
			{}
		);
		if (outcome.type === "success") {
			throw new Error(
				"The non-interactive approval ask was unexpectedly allowed."
			);
		}
		approvalErrorText = outcome.errorText;
		throw new Error(outcome.errorText);
	} catch (error) {
		if (approvalErrorText.length === 0) {
			approvalErrorText =
				error instanceof Error ? error.message : String(error);
		}
		throw error;
	}
};
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder, approvalScript)
);
const { buildAgentRegistry } = await import("../modules/agents/registry");
const { createPermissionService } = await import(
	"../modules/permissions/permission-service"
);
const { createSessionCapabilities } = await import(
	"../modules/sessions/host/session-capabilities"
);
const registry = buildAgentRegistry(
	fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {},
		sourceFor: () => undefined,
		sources: [],
	})
);
const { runPrintMode } = await import("../modules/application/modes/one-shot");

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
		workspace: root,
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
	expect(stderr.text).toContain("Agent Turn did not complete.");
});
