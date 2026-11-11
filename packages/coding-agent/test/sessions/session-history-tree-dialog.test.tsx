import { expect, mock, test } from "bun:test";
import { act, useEffect } from "react";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import type { SessionSdk } from "@/modules/sessions/sdk-contract";
import type {
	SessionHistoryTreeEntry,
	SessionHistoryTreePage,
} from "@/modules/sessions/session-pagination-types";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import { SessionHistoryTreeDialogContent } from "@/modules/sessions/ui/dialogs/session-history-tree-dialog";
import { toSessionId } from "@/shared/identifiers";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { testRenderWithClipboard } from "../support/clipboard";
import { agentId, agentTurnId, sessionMessageId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

const sessionId = toSessionId("history-tree-ui-session");
const createdAt = new Date("2026-01-02T03:04:05.000Z");
const record = buildUserSessionRecord({
	agentId: agentId("history-tree-ui-agent"),
	message: {
		id: sessionMessageId("history-tree-ui-message"),
		parts: [{ text: "A safe text preview\u001b[31m", type: "text" }],
		role: "user",
	},
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
	turnId: agentTurnId("history-tree-ui-turn"),
});
const recordEntry: SessionHistoryTreeEntry = {
	createdAt,
	id: "entry-history-ui-record",
	kind: "record",
	parentEntryId: null,
	record,
	recordId: record.id,
	selectedPath: true,
	sequence: 2,
};
const pluginStateEntry = {
	createdAt,
	id: "entry-history-ui-plugin-state",
	key: "queue \u001b[31m",
	kind: "plugin-state",
	operation: "set",
	parentEntryId: "entry-history-ui-record",
	pluginId: "queue_plugin",
	schemaVersion: 1,
	selectedPath: true,
	sequence: 3,
	value: { secret: "must-not-appear" },
} satisfies Extract<SessionHistoryTreeEntry, { kind: "plugin-state" }> & {
	value: unknown;
};
const entries: SessionHistoryTreeEntry[] = [recordEntry, pluginStateEntry];
const laterEntries: SessionHistoryTreeEntry[] = Array.from(
	{ length: 12 },
	(_, index) => {
		const laterRecord = buildUserSessionRecord({
			agentId: agentId(`history-tree-ui-later-agent-${index}`),
			message: {
				id: sessionMessageId(`history-tree-ui-later-message-${index}`),
				parts: [{ text: `later entry ${index}`, type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId(`history-tree-ui-later-turn-${index}`),
		});
		return {
			createdAt,
			id: `entry-history-ui-later-record-${index}`,
			kind: "record",
			parentEntryId:
				index === 0
					? "entry-history-ui-plugin-state"
					: `entry-history-ui-later-record-${index - 1}`,
			record: laterRecord,
			recordId: laterRecord.id,
			selectedPath: true,
			sequence: index + 4,
		} satisfies Extract<SessionHistoryTreeEntry, { kind: "record" }>;
	}
);
const laterEntry = laterEntries.at(-1);
if (laterEntry === undefined) {
	throw new Error("History tree UI fixture requires a later record");
}
const page: SessionHistoryTreePage = {
	activeLeafId: laterEntry.id,
	historyGeneration: 0,
	entries,
	nextCursor: "history-tree-ui-next-page",
	readPoint: "history-tree-ui-read-point",
};
const nextPage: SessionHistoryTreePage = {
	activeLeafId: laterEntry.id,
	historyGeneration: 0,
	entries: laterEntries,
	readPoint: page.readPoint,
};

test("history previews neutralize terminal controls, hide Plugin State payloads, and cancel without changing the leaf", async () => {
	const reads: Array<{ cursor?: string; limit?: number }> = [];
	const navigationTargets: Array<string | null> = [];
	const navigateSessionHistory = mock(
		async (_sessionId: string, targetEntryId: string | null) => {
			navigationTargets.push(targetEntryId);
			return targetEntryId === null
				? { kind: "unchanged" as const, activeLeafId: null }
				: { kind: "rejected" as const, reason: "history entry unavailable" };
		}
	);
	const readSessionHistoryTreePage = mock(
		async (
			_sessionId: string,
			options?: { cursor?: string; limit?: number }
		) => {
			reads.push(options ?? {});
			return options?.cursor === undefined ? page : nextPage;
		}
	);
	const sessionSdk: Pick<
		SessionSdk,
		"navigateSessionHistory" | "readSessionHistoryTreePage"
	> = {
		navigateSessionHistory,
		readSessionHistoryTreePage,
	};

	function Harness() {
		const { open } = useDialog();
		useEffect(() => {
			open({
				children: (
					<SessionHistoryTreeDialogContent
						sessionId={sessionId}
						sessionSdk={sessionSdk}
					/>
				),
				title: "Session history",
				width: 80,
			});
		}, [open]);
		return null;
	}

	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<KeyboardLayerProvider>
				<DialogProvider>
					<Harness />
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 18, kittyKeyboard: true, width: 64 }
	);

	try {
		await flushTestRenderer(setup, 2);
		let frame = setup.captureCharFrame();
		expect(frame).toContain("Enter selects a history entry");
		expect(frame).toContain("Current leaf is on a later page");
		expect(frame).toContain("queue_plugin / queue [31m · set · v1");
		expect(frame).toContain("A safe text preview [31m");
		expect(frame).not.toContain("\u001b");

		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressKey("p"));
		await flushTestRenderer(setup, 2);
		frame = setup.captureCharFrame();
		expect(frame).toContain("Plugin State payload is intentionally hidden");
		expect(frame).toContain("queue_plugin / queue [31m");
		expect(frame).not.toContain("\u001b");
		expect(frame).not.toContain("must-not-appear");

		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("Search Session history");

		await act(() => setup.mockInput.pressArrow("up"));
		await act(() => setup.mockInput.pressKey("p"));
		await flushTestRenderer(setup, 2);
		frame = setup.captureCharFrame();
		expect(frame).toContain("A safe text preview [31m");
		expect(frame).not.toContain("\u001b");
		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("Search Session history");

		await act(() => {
			setup.mockInput.pressArrow("down", { ctrl: true });
		});
		await flushTestRenderer(setup, 2);
		expect(reads).toHaveLength(2);
		frame = setup.captureCharFrame();
		expect(frame).toContain("Current leaf: entry 15");
		for (
			let attempt = 0;
			attempt < 16 && !frame.includes("later entry 11");
			attempt += 1
		) {
			await act(() => setup.mockInput.pressArrow("down"));
			await flushTestRenderer(setup);
			frame = setup.captureCharFrame();
		}
		expect(frame).toContain("L Record · user · later entry 11");
		for (let attempt = 0; attempt < 13; attempt += 1) {
			await act(() => setup.mockInput.pressArrow("up"));
		}
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 2);
		frame = setup.captureCharFrame();
		expect(frame).toContain("history entry unavailable");
		expect(navigationTargets).toEqual([recordEntry.id]);
		await act(() => setup.mockInput.pressKey("HOME", { ctrl: true }));
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).not.toContain("Search Session history");
		expect(navigationTargets).toEqual([recordEntry.id, null]);
		expect(readSessionHistoryTreePage).toHaveBeenCalledTimes(2);
		expect(reads).toEqual([
			{ limit: 40 },
			{ cursor: "history-tree-ui-next-page", limit: 40 },
		]);
		expect(page.activeLeafId).toBe(laterEntry.id);
	} finally {
		act(() => setup.renderer.destroy());
	}
});
