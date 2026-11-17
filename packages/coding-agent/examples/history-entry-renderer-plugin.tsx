import type { PluginEntryRenderer, PluginFactory } from "@wincode/coding-agent";
import { z } from "zod";

const notePayloadSchema = z
	.object({ message: z.string().max(200), schemaVersion: z.literal(1) })
	.strict();

const NoteHistoryEntry: PluginEntryRenderer = ({ entry, options, theme }) => {
	const payload = notePayloadSchema.safeParse(entry.payload);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={theme.colors.primary}>
				{`Note · entry ${entry.sequence} · ${options.selectedPath ? "Selected Path" : "inactive branch"}`}
			</text>
			<text fg={theme.colors.text}>
				{payload.success
					? payload.data.message
					: "Unsupported note payload version."}
			</text>
		</box>
	);
};

const historyEntryRendererPlugin: PluginFactory = (api) => {
	const notes = api.definePlugin({ id: "history_entry_renderer" });
	api.registerEntryRenderer("note-added", NoteHistoryEntry);
	notes.registerTool({
		description: "Add a durable note to the current Session branch.",
		executionMode: "sequential",
		inputSchema: z.object({ message: z.string().trim().min(1).max(200) }),
		name: "add_note",
		handler: async ({ message }, { sessionHistory, toolCallId }) => {
			if (sessionHistory === undefined) {
				return { type: "failure", errorText: "No Session is active." };
			}
			const operationId = new Bun.CryptoHasher("sha256")
				.update(toolCallId)
				.digest("hex");
			await sessionHistory.append(
				"note-added",
				{ message, schemaVersion: 1 },
				`note-added-${operationId}`
			);
			return { type: "success", output: { recorded: true } };
		},
	});
};

export default historyEntryRendererPlugin;
