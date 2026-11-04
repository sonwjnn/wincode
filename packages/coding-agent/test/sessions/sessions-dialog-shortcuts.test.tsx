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
		{ height: 24, kittyKeyboard: false, width: 100 }
	);

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
		{ height: 24, kittyKeyboard: false, width: 100 }
	);

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
