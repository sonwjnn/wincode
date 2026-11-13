import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSdkEvent } from "@wincode/coding-agent";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { removeTemporaryDirectory } from "../support/temporary-directory";

test("Fork of a completed reasoning turn inherits usage without rejecting its ThinkingLevel as Model identity", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-fork-reasoning-")
	);
	const recorder = createFakeProviderRecorder();
	const sdk = await createSessionSdkWithRuntime({
		cwd: directory,
		workspace: directory,
		databasePath: path.join(directory, "sessions.sqlite"),
		pluginPaths: [],
		createProviderCollection: () => createFakeProviderCollection(recorder),
	});
	try {
		const source = await sdk.createSession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			thinkingLevel: "low",
		});
		const terminal = Promise.withResolvers<SessionSdkEvent>();
		const unsubscribe = source.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed"
			) {
				terminal.resolve(event);
			}
		});
		try {
			const admission = await source.prompt({ text: "Reasoning fork source." });
			expect(admission.rejected).toBe(false);
			expect((await terminal.promise).type).toBe("agent-turn-completed");
			const history = await sdk.readSessionHistoryTreePage(source.sessionId);
			const checkpoint = history.entries.find(
				(entry) =>
					entry.kind === "record" && entry.record.outcome.kind === "assistant"
			);
			if (checkpoint?.kind !== "record") {
				throw new Error("Completed reasoning Record was not published.");
			}
			expect(checkpoint.record.model.thinkingLevel).toBe("low");
			const fork = await source.fork(
				{ recordId: checkpoint.recordId },
				"fork-reasoning-usage"
			);
			try {
				expect(fork.id).not.toBe(source.sessionId);
				expect(recorder.requests).toHaveLength(1);
				const statistics = await sdk.getSessionStatistics(fork.id);
				expect(statistics.usage.actual.contributionCount).toBe(0);
				expect(statistics.usage.inherited).toMatchObject({
					contributionCount: 1,
					inputTokens: 1,
					outputTokens: 1,
				});
				expect(statistics.usage.contributions.inherited[0]?.model).toEqual(
					DEFAULT_PROVIDER_MODEL_SELECTION
				);
				const childHistory = await sdk.readSessionHistoryTreePage(fork.id);
				expect(
					childHistory.entries.some(
						(entry) =>
							entry.kind === "record" &&
							entry.record.model.thinkingLevel === "low"
					)
				).toBe(true);
			} finally {
				await fork.handle.dispose();
			}
		} finally {
			unsubscribe();
			await source.dispose();
		}
	} finally {
		await sdk.dispose();
		await removeTemporaryDirectory(directory);
	}
}, 15_000);
