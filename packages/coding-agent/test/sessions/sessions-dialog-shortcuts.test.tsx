import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { act } from "react";
import type {
	Session,
	SessionCatalogPage,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { sessionId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";
import { renderSessionPicker } from "../support/session-picker-harness";

test("the Session picker deletes only after a second confirmation keypress", async () => {
	const page: SessionCatalogPage = {
		readPoint: "catalog-delete-read-point",
		sessions: [
			{
				createdAt: new Date("2025-01-01T00:00:00.000Z"),
				id: sessionId("session-delete-dialog"),
				lastMessageAt: null,
				pinned: false,
				title: "Delete candidate",
			} satisfies Session,
		],
	};
	const emptyPage: SessionCatalogPage = {
		readPoint: "catalog-delete-read-point",
		sessions: [],
	};
	let pageReads = 0;
	const refreshedPage = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(async () => {
		pageReads += 1;
		return pageReads === 1 ? page : await refreshedPage.promise;
	});
	const deleteSession = mock(async () => ({
		kind: "committed" as const,
		projection: "ready" as const,
	}));
	const store = fromPartial<SessionStore>({ deleteSession, listSessionsPage });
	const { getStoreSpy, setup } = await renderSessionPicker({
		kittyKeyboard: false,
		store,
	});

	try {
		await setup.waitFor(() => pageReads === 1);
		await flushTestRenderer(setup, 2);
		act(() => setup.mockInput.pressKey("d", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		expect(deleteSession).not.toHaveBeenCalled();
		expect(setup.captureCharFrame()).toContain("Delete candidate");
		await act(async () => {
			setup.mockInput.pressKey("d", { ctrl: true });
			await setup.waitFor(() => deleteSession.mock.calls.length === 1);
			await setup.waitFor(() => pageReads === 2);
			refreshedPage.resolve(emptyPage);
			await refreshedPage.promise;
		});
		await flushTestRenderer(setup, 2);
		expect(deleteSession).toHaveBeenCalledTimes(1);
		expect(setup.captureCharFrame()).toContain("No matching sessions");
	} finally {
		getStoreSpy.mockRestore();
		act(() => setup.renderer.destroy());
	}
});

test("the Session picker opens bundle import from a key legacy terminals can transmit", async () => {
	const page: SessionCatalogPage = {
		readPoint: "catalog-import-read-point",
		sessions: [
			{
				createdAt: new Date("2025-01-01T00:00:00.000Z"),
				id: sessionId("session-import-dialog"),
				lastMessageAt: null,
				pinned: false,
				title: "Import candidate",
			} satisfies Session,
		],
	};
	const pageResult = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(async () => await pageResult.promise);
	const store = fromPartial<SessionStore>({ listSessionsPage });
	const { getStoreSpy, setup } = await renderSessionPicker({
		kittyKeyboard: false,
		store,
	});

	try {
		await setup.waitFor(() => listSessionsPage.mock.calls.length === 1);
		await act(async () => {
			pageResult.resolve(page);
			await pageResult.promise;
		});
		await flushTestRenderer(setup, 2);
		act(() => setup.mockInput.pressKey("o", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Import a validated local Session bundle");
		expect(frame).toContain("./session-bundle");
	} finally {
		getStoreSpy.mockRestore();
		act(() => setup.renderer.destroy());
	}
});
