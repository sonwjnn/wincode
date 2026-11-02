import { expect, mock, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { fromPartial } from "@total-typescript/shoehorn";
import { act, useEffect } from "react";
import * as sessionStoreModule from "@/modules/sessions/storage/get-session-store";
import type {
	Session,
	SessionCatalogPage,
	SessionPageOptions,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { SessionsDialogContent } from "@/modules/sessions/ui/dialogs/sessions-dialog";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { testRenderWithClipboard } from "../support/clipboard";
import { sessionId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

const makeSession = (id: string, title: string): Session => ({
	createdAt: new Date("2025-01-01T00:00:00.000Z"),
	id: sessionId(id),
	lastMessageAt: null,
	pinned: false,
	title,
});

const DialogLayerProbe = () => {
	const { pop, push } = useKeyboardLayer();

	useEffect(() => {
		push("dialog");
		return () => pop("dialog");
	}, [pop, push]);

	return null;
};

const createRouterForDialog = () => {
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		component: () => null,
		getParentRoute: () => rootRoute,
		path: "/sessions/$id",
	});
	return createRouter({
		history: createMemoryHistory({ initialEntries: ["/sessions/current"] }),
		routeTree: rootRoute.addChildren([sessionRoute]),
	});
};

test("the Session picker asks for a destination before exporting the selected Session", async () => {
	const page: SessionCatalogPage = {
		readPoint: "catalog-export-read-point",
		sessions: [makeSession("session-export-dialog", "Export candidate")],
	};
	const pageResult = Promise.withResolvers<SessionCatalogPage>();
	const listSessionsPage = mock(async () => await pageResult.promise);
	const store = fromPartial<SessionStore>({ listSessionsPage });
	const getStoreSpy = spyOn(
		sessionStoreModule,
		"getSessionStore"
	).mockReturnValue(store);
	const router = createRouterForDialog();
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ToastProvider>
				<KeyboardLayerProvider>
					<DialogLayerProbe />
					<DialogProvider>
						<RouterContextProvider router={router}>
							<SessionsDialogContent />
						</RouterContextProvider>
					</DialogProvider>
				</KeyboardLayerProvider>
			</ToastProvider>
		</ThemeProvider>,
		{ height: 24, kittyKeyboard: true, width: 100 }
	);

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
		expect(frame).toContain("local bundle directory");
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
	const getStoreSpy = spyOn(
		sessionStoreModule,
		"getSessionStore"
	).mockReturnValue(store);
	const router = createRouterForDialog();
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ToastProvider>
				<KeyboardLayerProvider>
					<DialogLayerProbe />
					<DialogProvider>
						<RouterContextProvider router={router}>
							<SessionsDialogContent />
						</RouterContextProvider>
					</DialogProvider>
				</KeyboardLayerProvider>
			</ToastProvider>
		</ThemeProvider>,
		{ height: 24, kittyKeyboard: true, width: 100 }
	);

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
