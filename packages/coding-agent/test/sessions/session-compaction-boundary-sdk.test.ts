import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderChatEvent } from "@wincode/ai";
import type { SessionSdkEvent, SessionSdkHandle } from "@wincode/coding-agent";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import {
	createInMemoryConfigStore,
	TEST_CONFIG_ROOT,
	TEST_HOME_ROOT,
} from "../support/config-store";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { removeTemporaryDirectory } from "../support/temporary-directory";

for (const includeReasoning of [false, true]) {
	test(`compacting a live ${includeReasoning ? "reasoning" : "text"} turn remains reopenable and forkable after runtime parts disappear from Records`, async () => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-compaction-boundary-")
		);
		const configStore = createInMemoryConfigStore({
			[`${TEST_CONFIG_ROOT}/settings.json`]: JSON.stringify({
				compaction: { keepRecentTokens: 256, reserveTokens: 1024 },
			}),
		});
		await configStore.getSnapshot(directory);
		const recorder = createFakeProviderRecorder();
		let requests = 0;
		recorder.stepScript = async function* (
			request
		): AsyncGenerator<ProviderChatEvent> {
			requests++;
			if (includeReasoning && !request.system?.includes("session summarizer")) {
				yield { type: "reasoning-delta", delta: "Runtime-only reasoning." };
			}
			yield { type: "text-delta", delta: "Retained boundary marker." };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish", completion: { kind: "completed" } };
		};
		const services = await openSessionServices({
			policy: {
				cwd: directory,
				workspace: directory,
				databasePath: path.join(directory, "sessions.sqlite"),
			},
			sources: {
				configRuntime: () => ({
					configStore,
					homeRoot: TEST_HOME_ROOT,
					workspace: directory,
				}),
				createProviderCollection: () => createFakeProviderCollection(recorder),
			},
		});
		const sdk = await services.sessionSdk.createSessionRuntime({
			pluginPaths: [],
		});
		const handles: SessionSdkHandle[] = [];
		const prompt = async (
			handle: SessionSdkHandle,
			text: string
		): Promise<void> => {
			const terminal = Promise.withResolvers<SessionSdkEvent>();
			const unsubscribe = handle.onEvent((event) => {
				if (
					event.type === "agent-turn-completed" ||
					event.type === "agent-turn-failed"
				) {
					terminal.resolve(event);
				}
			});
			try {
				expect(
					(
						await handle.prompt({
							text,
							model: DEFAULT_PROVIDER_MODEL_SELECTION,
							thinkingLevel: "low",
							maximumModelSteps: 1,
						})
					).rejected
				).toBe(false);
				expect((await terminal.promise).type).toBe("agent-turn-completed");
			} finally {
				unsubscribe();
			}
		};
		try {
			const sessionId = await sdk.createEmptySession({
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				thinkingLevel: "low",
			});
			const manager = services.capabilities.getSessionHostManager();
			const host = await manager.openHost({
				capabilities: services.capabilities,
				sessionId,
				autoContinue: false,
				view: false,
			});
			const source = await sdk.openSession(sessionId, { autoContinue: false });
			handles.push(source);
			await prompt(source, "large original request ".repeat(50));
			await prompt(source, "short follow-up before compaction");
			// The same Host must compact its live projection, not an already-reloaded durable projection.
			expect(
				host
					.getSnapshot()
					.context.some((message) =>
						message.parts.some((part) => part.type === "step-start")
					)
			).toBe(true);
			expect(
				(
					await services.capabilities.getCompactionSettings(
						DEFAULT_PROVIDER_MODEL_SELECTION
					)
				).keepRecentTokens
			).toBe(256);
			await host.agentSession.compact({
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				trigger: "manual",
			});
			await source.dispose();
			const reopened = await sdk.openSession(source.sessionId, {
				autoContinue: false,
			});
			handles.push(reopened);
			await prompt(reopened, "Continue after reopening compacted history.");
			const records = await services.store.listSessionRecords(source.sessionId);
			const checkpoint = records.findLast(
				(record) => record.outcome.kind === "assistant"
			);
			if (checkpoint === undefined) {
				throw new Error("Completed checkpoint was not published.");
			}
			const beforeFork = requests;
			const fork = await reopened.fork(
				{ recordId: checkpoint.id },
				"durable-compaction-boundary-fork"
			);
			handles.push(fork.handle);
			expect(requests).toBe(beforeFork);
			const inherited = await services.store.getCompactions(fork.id);
			expect(inherited).toHaveLength(1);
			expect(inherited[0]?.summary.text).toContain("Retained boundary marker.");
			await fork.handle.dispose();
			const reopenedFork = await sdk.openSession(fork.id, {
				autoContinue: false,
			});
			handles.push(reopenedFork);
			await prompt(reopenedFork, "Continue the independent compacted child.");
		} finally {
			await Promise.allSettled(handles.map((handle) => handle.dispose()));
			await sdk.dispose();
			await services.shutdown();
			await removeTemporaryDirectory(directory);
		}
	}, 15_000);
}
