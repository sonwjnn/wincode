import { spyOn } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { useEffect } from "react";
import * as sessionStoreModule from "@/modules/sessions/storage/get-session-storage";
import type { SessionStorage } from "@/modules/sessions/storage/session-storage";
import { SessionsDialogContent } from "@/modules/sessions/ui/dialogs/sessions-dialog";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { testRenderWithClipboard } from "./clipboard";

const DialogLayerProbe = () => {
	const { pop, push } = useKeyboardLayer();

	useEffect(() => {
		push("dialog");
		return () => pop("dialog");
	}, [pop, push]);

	return null;
};

export const createSessionPickerRouter = () => {
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

/**
 * Renders the Session picker against a partial store and returns the renderer
 * plus the `getSessionStorage` spy the caller must restore.
 */
export const renderSessionPicker = async ({
	kittyKeyboard,
	storage,
}: Readonly<{ kittyKeyboard: boolean; storage: SessionStorage }>) => {
	const getSessionStorageSpy = spyOn(
		sessionStoreModule,
		"getSessionStorage"
	).mockReturnValue(storage);
	const router = createSessionPickerRouter();
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
		{ height: 24, kittyKeyboard, width: 100 }
	);
	return { getSessionStorageSpy, router, setup };
};
