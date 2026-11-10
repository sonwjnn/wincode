import type { PluginFactory, PluginSessionState } from "@wincode/coding-agent";
import { PluginSessionStateVersionError } from "@wincode/coding-agent";
import { z } from "zod";

const itemSchema = z.string().trim().min(1).max(200);
const itemsSchema = z.array(itemSchema);

const readItems = async (state: PluginSessionState): Promise<string[]> => {
	const snapshot = await state.read("items");
	if (snapshot.kind === "incompatible") {
		throw new PluginSessionStateVersionError(snapshot.schemaVersion);
	}
	return snapshot.kind === "absent" ? [] : itemsSchema.parse(snapshot.value);
};

const checklistPlugin: PluginFactory = (api) => {
	const checklist = api.definePlugin({
		id: "checklist",
		sessionStateVersion: 1,
	});
	checklist.onSessionStart(async ({ sessionState }) => {
		// Restore/validate data only. Never replay actions from a saved checklist.
		if (sessionState !== undefined) {
			await readItems(sessionState);
		}
	});
	checklist.registerTool({
		name: "add_item",
		description:
			"Add an item to this Session's checklist; duplicate items are unchanged.",
		executionMode: "sequential",
		inputSchema: z.object({ item: itemSchema }),
		handler: async ({ item }, { sessionState, toolCallId }) => {
			if (sessionState === undefined) {
				return { type: "failure", errorText: "No Session is active." };
			}
			// Read inside the scheduled handler, not before the batch begins.
			const items = await readItems(sessionState);
			if (!items.includes(item)) {
				items.push(item);
				const operationId = new Bun.CryptoHasher("sha256")
					.update(toolCallId)
					.digest("hex");
				await sessionState.set("items", items, `checklist-add-${operationId}`);
			}
			return { type: "success", output: { items } };
		},
	});
	checklist.registerTool({
		name: "list_items",
		description: "Read this Session's saved checklist.",
		inputSchema: z.object({}),
		handler: async (_input, { sessionState }) =>
			sessionState === undefined
				? { type: "failure", errorText: "No Session is active." }
				: { type: "success", output: { items: await readItems(sessionState) } },
	});
};

export default checklistPlugin;
