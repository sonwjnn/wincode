process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { fromPartial } from "@total-typescript/shoehorn";
import { act, useEffect } from "react";
import type {
	Session,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";

const sessions: Session[] = [
	{
		createdAt: new Date("2026-09-10T09:00:00.000Z"),
		id: "session-a",
		lastMessageAt: new Date("2026-09-10T09:00:00.000Z"),
		pinned: false,
		title: "Session A",
	},
	{
		createdAt: new Date("2026-09-11T09:00:00.000Z"),
		id: "session-b",
		lastMessageAt: new Date("2026-09-11T09:00:00.000Z"),
		pinned: false,
		title: "Session B",
	},
];
const deletedSessionIds: string[] = [];
const sessionStore = fromPartial<SessionStore>({
	deleteSession: mock(async (sessionId: string) => {
		deletedSessionIds.push(sessionId);
	}),
	listSessions: mock(async () => sessions),
});
await mock.module(
	`${import.meta.dir}/../../modules/sessions/storage/get-session-store.ts`,
	() => ({
		getSessionStore: () => sessionStore,
	})
);

// The dialog imports its store before the test can render it, so load it only after
// registering the deterministic store replacement.
const { SessionsDialogContent } = await import(
	"@/modules/sessions/ui/dialogs/sessions-dialog"
);
const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		await setup.renderOnce();
	});
};

const buildRouter = () => {
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		component: () => null,
		getParentRoute: () => rootRoute,
		path: "/sessions/$id",
	});
	return createRouter({
		history: createMemoryHistory({ initialEntries: ["/sessions/session-1"] }),
		routeTree: rootRoute.addChildren([sessionRoute]),
	});
};

const renderSessionsDialog = async () => {
	function Harness() {
		const { open } = useDialog();
		const { push } = useKeyboardLayer();

		useEffect(() => {
			push("dialog");
			open({
				children: <SessionsDialogContent />,
				title: "Sessions",
			});
		}, [open, push]);

		return <text>base</text>;
	}

	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ToastProvider>
					<RouterContextProvider router={buildRouter()}>
						<DialogProvider>
							<Harness />
						</DialogProvider>
					</RouterContextProvider>
				</ToastProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 30, width: 100 }
	);

	for (let attempt = 0; attempt < 5; attempt += 1) {
		await flushUi(setup);
		if (setup.captureCharFrame().includes("Session A")) {
			break;
		}
	}
	return setup;
};

test("confirms deletion for the highlighted session across rerenders", async () => {
	deletedSessionIds.length = 0;
	const setup = await renderSessionsDialog();
	try {
		await act(() => setup.mockInput.pressArrow("down"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressKey("d", { ctrl: true }));
		await flushUi(setup);

		expect(setup.captureCharFrame()).toContain("confirm delete");
		expect(deletedSessionIds).toEqual([]);

		await act(() => setup.mockInput.pressKey("d", { ctrl: true }));
		await flushUi(setup);
		expect(deletedSessionIds).toEqual(["session-b"]);
		expect(setup.captureCharFrame()).not.toContain("Session B");
	} finally {
		setup.renderer.destroy();
	}
});

test("moves delete confirmation to a newly highlighted session", async () => {
	deletedSessionIds.length = 0;
	const setup = await renderSessionsDialog();
	try {
		await act(() => setup.mockInput.pressArrow("down"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressKey("d", { ctrl: true }));
		await flushUi(setup);

		await act(() => setup.mockInput.pressArrow("up"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressKey("d", { ctrl: true }));
		await flushUi(setup);

		expect(setup.captureCharFrame()).toContain("confirm delete");
		expect(deletedSessionIds).toEqual([]);

		await act(() => setup.mockInput.pressKey("d", { ctrl: true }));
		await flushUi(setup);
		expect(deletedSessionIds).toEqual(["session-a"]);
		expect(setup.captureCharFrame()).not.toContain("Session A");
	} finally {
		setup.renderer.destroy();
	}
});
