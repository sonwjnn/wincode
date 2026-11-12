import type {
	PluginFactory,
	PluginSessionHistory,
} from "@wincode/coding-agent";
import { z } from "zod";

const itemSchema = z.string().trim().min(1).max(200);
const addedItemSchema = z
	.object({ item: itemSchema, schemaVersion: z.literal(1) })
	.strict();

type ChecklistProjection = Readonly<{
	incompatibleEntries: number;
	items: readonly string[];
}>;

const readSelectedPath = async (
	history: PluginSessionHistory
): Promise<ChecklistProjection> => {
	const items: string[] = [];
	let incompatibleEntries = 0;
	let cursor: string | undefined;
	let readPoint: string | undefined;
	while (true) {
		const page = await history.read(
			cursor === undefined ? { limit: 100 } : { cursor, limit: 100 }
		);
		if (readPoint !== undefined && page.readPoint !== readPoint) {
			throw new Error("Checklist history pages came from different snapshots.");
		}
		readPoint = page.readPoint;
		for (const entry of page.entries) {
			if (entry.type !== "item-added") {
				continue;
			}
			const parsed = addedItemSchema.safeParse(entry.payload);
			if (!parsed.success) {
				incompatibleEntries += 1;
				continue;
			}
			items.push(parsed.data.item);
		}
		if (page.nextCursor === undefined) {
			break;
		}
		cursor = page.nextCursor;
	}
	return { incompatibleEntries, items };
};

const checklistHistoryPlugin: PluginFactory = (api) => {
	const checklist = api.definePlugin({ id: "checklist_history" });
	const restoredBySession = new Map<string, ChecklistProjection>();
	const restore = async (
		sessionId: string,
		history: PluginSessionHistory | undefined
	): Promise<void> => {
		if (history === undefined) {
			restoredBySession.delete(sessionId);
			return;
		}
		restoredBySession.set(sessionId, await readSelectedPath(history));
	};

	checklist.onSessionStart(async ({ sessionId, sessionHistory }) => {
		await restore(sessionId, sessionHistory);
	});
	checklist.onSessionHistoryNavigated(async ({ sessionId, sessionHistory }) => {
		await restore(sessionId, sessionHistory);
	});
	checklist.onSessionShutdown(({ sessionId }) => {
		restoredBySession.delete(sessionId);
	});

	checklist.registerTool({
		name: "add_item",
		description: "Add an item to this Session's branch-aware checklist.",
		executionMode: "sequential",
		inputSchema: z.object({ item: itemSchema }),
		handler: async ({ item }, { sessionHistory, sessionId, toolCallId }) => {
			if (sessionHistory === undefined) {
				return { type: "failure", errorText: "No Session is active." };
			}
			const current = await readSelectedPath(sessionHistory);
			if (!current.items.includes(item)) {
				const operationId = new Bun.CryptoHasher("sha256")
					.update(toolCallId)
					.digest("hex");
				await sessionHistory.append(
					"item-added",
					{ item, schemaVersion: 1 },
					`checklist-add-${operationId}`
				);
			}
			const updated = await readSelectedPath(sessionHistory);
			restoredBySession.set(sessionId, updated);
			return {
				type: "success",
				output: {
					incompatibleEntries: updated.incompatibleEntries,
					items: updated.items,
				},
			};
		},
	});
	checklist.registerTool({
		name: "list_items",
		description: "Read this branch's saved checklist items.",
		inputSchema: z.object({}),
		handler: async (_input, { sessionHistory, sessionId }) => {
			if (sessionHistory === undefined) {
				return { type: "failure", errorText: "No Session is active." };
			}
			const projection =
				restoredBySession.get(sessionId) ??
				(await readSelectedPath(sessionHistory));
			restoredBySession.set(sessionId, projection);
			return {
				type: "success",
				output: {
					incompatibleEntries: projection.incompatibleEntries,
					items: projection.items,
				},
			};
		},
	});
};

export default checklistHistoryPlugin;
