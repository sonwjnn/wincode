import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { act } from "react";
import type {
	Session,
	SessionCatalogPage,
	SessionPageOptions,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { sessionId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";
import { renderSessionPicker } from "../support/session-picker-harness";

const makeSession = (id: string, title: string): Session => ({
	createdAt: new Date("2025-01-01T00:00:00.000Z"),
	id: sessionId(id),
	lastMessageAt: null,
	pinned: false,
	title,
});

test("the Session picker asks for a destination before exporting the selected Session", async () => {
	const page: SessionCatalogPage = {
		readPoint: "catalog-export-read-point",
		sessions: [makeSession("session-export-dialog", "Export candidate")],
	};
	const pageResult = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(async () => await pageResult.promise);
	const store = fromPartial<SessionStore>({ listSessionsPage });
	const { getStoreSpy, setup } = await renderSessionPicker({
		kittyKeyboard: true,
		store,
	});

	try {
		await setup.waitFor(() => listSessionsPage.mock.calls.length === 1);
		await act(async () => {
			pageResult.resolve(page);
			await pageResult.promise;
		});
		await flushTestRenderer(setup, 2);
		act(() => setup.mockInput.pressKey("e", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Export candidate");
		expect(frame).toContain("Whole tree keeps the Session identity");
		expect(frame).toContain("Selected Path");
		expect(frame).toContain("./session-bundle");
		expect(frame).toContain("export");
	} finally {
		getStoreSpy.mockRestore();
		act(() => setup.renderer.destroy());
	}
});

test("the stored Session list loads from its cursor and refreshes to a new snapshot", async () => {
	const firstPage: SessionCatalogPage = {
		nextCursor: "catalog-cursor-1",
		readPoint: "catalog-revision-1",
		sessions: [makeSession("session-first", "First session")],
	};
	const nextPage: SessionCatalogPage = {
		readPoint: "catalog-revision-1",
		sessions: [makeSession("session-second", "Second session")],
	};
	const refreshedPage: SessionCatalogPage = {
		readPoint: "catalog-revision-2",
		sessions: [makeSession("session-refreshed", "Refreshed session")],
	};
	const requestedCursors: Array<string | undefined> = [];
	const firstPageResult = Promise.withResolvers<SessionCatalogPage>();
	const nextPageResult = Promise.withResolvers<SessionCatalogPage>();
	const refreshedPageResult = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(
		async (options?: SessionPageOptions): Promise<SessionCatalogPage> => {
			requestedCursors.push(options?.cursor);
			if (options?.cursor === "catalog-cursor-1") {
				return nextPageResult.promise;
			}
			return requestedCursors.length === 1
				? firstPageResult.promise
				: refreshedPageResult.promise;
		}
	);
	const store = fromPartial<SessionStore>({ listSessionsPage });
	const { getStoreSpy, setup } = await renderSessionPicker({
		kittyKeyboard: true,
		store,
	});

	try {
		await setup.waitFor(() => requestedCursors.length === 1);
		firstPageResult.resolve(firstPage);
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("First session");
		expect(setup.captureCharFrame()).toContain("Load more sessions");

		act(() => setup.mockInput.pressArrow("down", { ctrl: true }));
		await setup.waitFor(() => requestedCursors.length === 2);
		await act(async () => {
			nextPageResult.resolve(nextPage);
			await nextPageResult.promise;
		});
		await flushTestRenderer(setup, 2);
		expect(requestedCursors).toEqual([undefined, "catalog-cursor-1"]);
		expect(setup.captureCharFrame()).toContain("Second session");

		act(() => setup.mockInput.pressKey("r", { ctrl: true, shift: true }));
		await setup.waitFor(() => requestedCursors.length === 3);
		await act(async () => {
			refreshedPageResult.resolve(refreshedPage);
			await refreshedPageResult.promise;
		});
		await flushTestRenderer(setup, 2);
		expect(requestedCursors).toEqual([
			undefined,
			"catalog-cursor-1",
			undefined,
		]);
		expect(setup.captureCharFrame()).toContain("Refreshed session");
		expect(setup.captureCharFrame()).not.toContain("Second session");
	} finally {
		getStoreSpy.mockRestore();
		act(() => setup.renderer.destroy());
	}
});
