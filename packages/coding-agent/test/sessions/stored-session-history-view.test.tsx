import { expect, mock, test } from "bun:test";
import { act } from "react";
import { StoredSessionHistoryView } from "@/modules/sessions/ui/views/stored-session-history-view";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { testRenderWithClipboard } from "../support/clipboard";
import { flushTestRenderer } from "../support/opentui";

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
				sessionTitle="History title"
			/>
		</ThemeProvider>,
		{ height: 18, kittyKeyboard: true, width: 100 }
	);

	try {
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Load older history");
		expect(frame).toContain("Refresh history");
		expect(frame).toContain("No saved messages.");
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
				sessionTitle="History title"
			/>
		</ThemeProvider>,
		{ height: 18, kittyKeyboard: true, width: 100 }
	);

	try {
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		expect(frame).toContain(
			"Stored history changed. Refresh history to start a new snapshot."
		);
		expect(frame).toContain("Refresh history");
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
