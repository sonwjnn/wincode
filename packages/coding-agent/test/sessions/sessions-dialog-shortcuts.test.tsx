import { expect, mock, spyOn, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { act } from "react";
import * as sessionHostManagerModule from "@/modules/sessions/host/session-host-manager";
import type { SessionHostManager } from "@/modules/sessions/host/types";
import type { SessionBundleExportInput } from "@/modules/sessions/session-bundle-export";
import * as sessionBundleExportModule from "@/modules/sessions/session-bundle-export";
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

test("the Session picker opens an imported identity after refreshing the catalog", async () => {
	const importedSessionId = sessionId("session-imported-selected-path");
	const emptyPage: SessionCatalogPage = {
		readPoint: "catalog-import-read-point",
		sessions: [],
	};
	const importedPage: SessionCatalogPage = {
		readPoint: "catalog-imported-read-point",
		sessions: [
			{
				createdAt: new Date("2025-01-02T00:00:00.000Z"),
				id: importedSessionId,
				lastMessageAt: null,
				pinned: false,
				title: "Imported branch",
			} satisfies Session,
		],
	};
	let pageReads = 0;
	const initialPage = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(async () => {
		pageReads += 1;
		return pageReads === 1 ? await initialPage.promise : importedPage;
	});
	const withSessionBundleImport = mock(async () => ({
		activationPending: true,
		sessionId: importedSessionId,
		status: "imported" as const,
	}));
	const store = fromPartial<SessionStore>({
		listSessionsPage,
		withSessionBundleImport,
	});
	const { getStoreSpy, router, setup } = await renderSessionPicker({
		kittyKeyboard: false,
		store,
	});

	try {
		await setup.waitFor(() => pageReads === 1);
		await act(async () => {
			initialPage.resolve(emptyPage);
			await initialPage.promise;
		});
		await flushTestRenderer(setup, 2);
		act(() => setup.mockInput.pressKey("o", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		await act(async () => {
			await setup.mockInput.typeText("/tmp/selected-path.bundle");
		});
		await act(async () => {
			setup.mockInput.pressEnter();
			await setup.waitFor(
				() => withSessionBundleImport.mock.calls.length === 1
			);
			await setup.waitFor(() => pageReads === 2);
			await setup.waitFor(
				() =>
					router.state.location.pathname === `/sessions/${importedSessionId}`
			);
		});
		await flushTestRenderer(setup, 2);
		expect(withSessionBundleImport).toHaveBeenCalledTimes(1);
		expect(listSessionsPage).toHaveBeenCalledTimes(2);
		expect(router.state.location.pathname).toBe(
			`/sessions/${importedSessionId}`
		);
		expect(setup.captureCharFrame()).toContain("Imported branch");
		expect(setup.captureCharFrame()).not.toContain(
			"Import a validated local Session bundle"
		);
	} finally {
		getStoreSpy.mockRestore();
		act(() => setup.renderer.destroy());
	}
});

test("the Session picker shows both export scopes before writing a bundle", async () => {
	const page: SessionCatalogPage = {
		readPoint: "catalog-export-read-point",
		sessions: [
			{
				createdAt: new Date("2025-01-01T00:00:00.000Z"),
				id: sessionId("session-export-dialog"),
				lastMessageAt: null,
				pinned: false,
				title: "Export candidate",
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
		act(() => setup.mockInput.pressKey("e", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		const frame = setup.captureCharFrame();
		if (frame === undefined) {
			throw new Error("Expected the export scope dialog to render.");
		}
		expect(frame).toContain("Whole tree");
		expect(frame).toContain("Selected Path");
		expect(frame).toContain("default: Whole tree");
	} finally {
		getStoreSpy.mockRestore();
		act(() => setup.renderer.destroy());
	}
});

test("the export scope selection reaches bundle creation and defaults to whole tree", async () => {
	const sourceSessionId = sessionId("session-export-scope");
	const page: SessionCatalogPage = {
		readPoint: "catalog-export-scope-read-point",
		sessions: [
			{
				createdAt: new Date("2025-01-01T00:00:00.000Z"),
				id: sourceSessionId,
				lastMessageAt: null,
				pinned: false,
				title: "Export scope candidate",
			} satisfies Session,
		],
	};
	const pageResult = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(async () => await pageResult.promise);
	const store = fromPartial<SessionStore>({ listSessionsPage });
	const exportOperation = mock(async (input: SessionBundleExportInput) => {
		const scope = input.scope ?? "tree";
		return {
			destination: input.destination,
			manifest: {
				attachments: [],
				cut: { hash: "a".repeat(64), sequence: 1 },
				format: "wincode-session-bundle" as const,
				scope,
				session: { id: sourceSessionId, logId: "export-scope-test-log" },
				sessionFile: {
					byteLength: 0,
					path: "session.jsonl" as const,
					sha256: "b".repeat(64),
				},
				version: 2 as const,
			},
			sessionId: sourceSessionId,
			status: "exported" as const,
		};
	});
	const createExportSpy = spyOn(
		sessionBundleExportModule,
		"createSessionBundleExportOperation"
	).mockReturnValue(exportOperation);
	const hostManagerSpy = spyOn(
		sessionHostManagerModule,
		"getInteractiveSessionHostManager"
	).mockReturnValue(fromPartial<SessionHostManager>({}));
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
		act(() => setup.mockInput.pressKey("e", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		await act(async () => {
			await setup.mockInput.typeText("/tmp/selected-path.bundle");
			setup.mockInput.pressTab();
		});
		await flushTestRenderer(setup, 2);
		act(() => setup.mockInput.pressArrow("down"));
		await flushTestRenderer(setup, 2);
		await act(async () => {
			setup.mockInput.pressEnter();
			await setup.waitFor(() => exportOperation.mock.calls.length === 1);
		});
		act(() => setup.mockInput.pressKey("e", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		await act(async () => {
			await setup.mockInput.typeText("/tmp/whole-tree.bundle");
			setup.mockInput.pressEnter();
			await setup.waitFor(() => exportOperation.mock.calls.length === 2);
		});
		expect(exportOperation.mock.calls.map(([input]) => input.scope)).toEqual([
			"branch",
			"tree",
		]);
		expect(
			exportOperation.mock.calls.map(([input]) => input.destination)
		).toEqual(["/tmp/selected-path.bundle", "/tmp/whole-tree.bundle"]);
	} finally {
		createExportSpy.mockRestore();
		hostManagerSpy.mockRestore();
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
