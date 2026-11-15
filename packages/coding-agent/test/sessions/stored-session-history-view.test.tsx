import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { act } from "react";
import type { SessionCompaction } from "@/modules/sessions/compaction";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionForkProvenance } from "@/modules/sessions/storage/session-lifecycle";
import { StoredSessionHistoryView } from "@/modules/sessions/ui/views/stored-session-history-view";
import type { SessionStatistics } from "@/modules/sessions/usage/session-statistics";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { testRenderWithClipboard } from "../support/clipboard";
import { providerModelSelectionFixture } from "../support/identifiers";
import {
	flushTestRenderer,
	flushTestRendererUntilStable,
} from "../support/opentui";

const emptyUsage = {
	byModel: [],
	cacheReadTokens: null,
	cacheWriteTokens: null,
	contributionCount: 0,
	costs: [],
	inputTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	totalTokens: null,
	unknownCostCount: 0,
};
const statistics: SessionStatistics = {
	completedToolCallCount: 0,
	recordCount: 1,
	readPoint: "history-snapshot-token",
	sessionId: "history-session" as SessionStatistics["sessionId"],
	terminalOutcomeCounts: {
		cancelled: 0,
		completed: 0,
		failed: 0,
		interrupted: 0,
	},
	usage: {
		contributions: {
			actual: [],
			auxiliary: [],
			inherited: [],
			selectedPath: [],
		},
		actual: {
			...emptyUsage,
			contributionCount: 1,
			inputTokens: 12,
			outputTokens: 3,
			unknownCostCount: 1,
		},
		auxiliary: emptyUsage,
		selectedPath: {
			...emptyUsage,
			contributionCount: 1,
			inputTokens: 12,
			outputTokens: 3,
			unknownCostCount: 1,
		},
		inherited: {
			...emptyUsage,
			contributionCount: 1,
			costs: [
				{
					amount: 0.12,
					contributionCount: 1,
					model: providerModelSelectionFixture(
						"fixture-provider/fixture-model"
					),
					unit: "USD",
				},
			],
			inputTokens: 90,
			outputTokens: 20,
		},
	},
};

test("stored history exposes load-older and refresh actions without editing controls", async () => {
	const actions: string[] = [];
	const onLoadMore = mock(() => actions.push("load-more"));
	const onRefresh = mock(() => actions.push("refresh"));
	const onRetry = mock(() => actions.push("retry"));
	const onReselectModel = mock(() => actions.push("reselect-model"));
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<StoredSessionHistoryView
				compactions={[]}
				forkProvenance={fromPartial<SessionForkProvenance>({
					sourceAvailability: "unavailable",
					sourceMessageId: "source-message",
					sourceRecordId: "source-record",
					sourceSequence: 4,
					sourceSessionId: "source-session",
				})}
				hasMoreHistory
				isLoadingMore={false}
				isRefreshing={false}
				isRetrying={false}
				isSelectingModel={false}
				messages={[]}
				onLoadMore={onLoadMore}
				onRefresh={onRefresh}
				onReselectModel={onReselectModel}
				onRetry={onRetry}
				owner={undefined}
				sessionId={statistics.sessionId}
				sessionTitle="History title"
				statistics={statistics}
			/>
		</ThemeProvider>,
		{ height: 30, kittyKeyboard: true, width: 100 }
	);

	try {
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Load older history");
		expect(frame).toContain("Refresh history");
		expect(frame).toContain("No saved messages.");
		expect(frame).toContain("Persisted statistics");
		expect(frame).toContain("Forked from Session source-session");
		expect(frame).toContain("Record source-record");
		expect(frame).toContain(
			"Source Session is no longer available; inherited context and attachments remain available."
		);
		expect(frame).toContain(
			"Inherited usage is historical, not new Session spend"
		);
		expect(frame).toContain(
			"Selected-path usage follows the current history branch"
		);
		expect(frame).toContain("fixture-provider/fixture-model: 0.12 USD");
		expect(frame).toContain(
			"Selected path: 12 input / 3 output tokens; 1 cost unknown"
		);
		expect(frame).toContain(
			"Whole Session actual: 12 input / 3 output tokens; 1 cost unknown"
		);
		expect(frame).not.toContain("Ask anything...");

		for (const id of [
			"stored-session-history-load-more",
			"stored-session-history-refresh",
		]) {
			const action = setup.renderer.root.findDescendantById(id);
			expect(action?.focusable).toBe(true);
			await act(() => {
				action?.focus();
				setup.mockInput.pressEnter();
			});
		}

		expect(onLoadMore).toHaveBeenCalledTimes(1);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(actions).toEqual(["load-more", "refresh"]);
		expect(onRetry).not.toHaveBeenCalled();
		expect(onReselectModel).not.toHaveBeenCalled();
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("an expired stored-history cursor offers refresh instead of continuation", async () => {
	const onLoadMore = mock(() => true);
	const onRefresh = mock(() => true);
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<StoredSessionHistoryView
				compactions={[]}
				hasMoreHistory={false}
				historyError="Stored history changed. Refresh history to start a new snapshot."
				isLoadingMore={false}
				isRefreshing={false}
				isRetrying={false}
				isSelectingModel={false}
				messages={[]}
				onLoadMore={onLoadMore}
				onRefresh={onRefresh}
				onReselectModel={() => true}
				onRetry={() => true}
				owner={undefined}
				sessionId={statistics.sessionId}
				sessionTitle="History title"
				statistics={statistics}
			/>
		</ThemeProvider>,
		{ height: 30, kittyKeyboard: true, width: 100 }
	);

	try {
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("start a new snapshot");
		expect(frame).not.toContain("Load older history");

		const refreshAction = setup.renderer.root.findDescendantById(
			"stored-session-history-refresh"
		);
		await act(() => {
			refreshAction?.focus();
			setup.mockInput.pressEnter();
		});
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(onLoadMore).not.toHaveBeenCalled();
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("stored history places the divider after its anchor before later turns", async () => {
	const message = (id: string, role: SessionMessage["role"]): SessionMessage =>
		fromPartial<SessionMessage>({
			id,
			parts: [{ text: id, type: "text" }],
			role,
		});
	const messages = [
		message("history-user-1", "user"),
		message("history-assistant-1", "assistant"),
		message("history-user-2", "user"),
		message("history-assistant-2", "assistant"),
	];
	const compaction = fromPartial<SessionCompaction>({
		estimatedTokensAfter: 20,
		id: "history-compaction",
		sequence: 1,
		summary: { coveredMessageIds: [], formatVersion: 1, text: "" },
		throughMessageUiId: "history-assistant-1",
		tokensBefore: 40,
		trigger: "manual",
	});
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<StoredSessionHistoryView
				compactions={[compaction]}
				hasMoreHistory={false}
				isLoadingMore={false}
				isRefreshing={false}
				isRetrying={false}
				isSelectingModel={false}
				messages={messages}
				onLoadMore={() => true}
				onRefresh={() => true}
				onReselectModel={() => true}
				onRetry={() => true}
				owner={undefined}
				sessionId={statistics.sessionId}
				sessionTitle="History title"
				statistics={statistics}
			/>
		</ThemeProvider>,
		{ height: 80, kittyKeyboard: true, width: 100 }
	);

	try {
		await flushTestRendererUntilStable(setup);
		const lines = setup.captureCharFrame().split("\n");
		const anchorLine = lines.findIndex((line) =>
			line.includes("history-assistant-1")
		);
		const dividerLine = lines.findIndex((line) =>
			line.includes("Compacted (manual)")
		);
		const laterTurnLine = lines.findIndex((line) =>
			line.includes("history-user-2")
		);
		expect(anchorLine).toBeGreaterThan(-1);
		expect(dividerLine).toBeGreaterThan(anchorLine);
		expect(laterTurnLine).toBeGreaterThan(dividerLine);
	} finally {
		act(() => setup.renderer.destroy());
	}
});
