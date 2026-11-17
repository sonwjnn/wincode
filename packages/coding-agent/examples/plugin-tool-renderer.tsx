import type {
	PluginFactory,
	PluginToolCallRenderer,
	PluginToolResultRenderer,
} from "@wincode/coding-agent";
import { z } from "zod";

const LookupCall: PluginToolCallRenderer = ({ call, height, theme, width }) => {
	const input = call.input;
	const query =
		input !== null &&
		typeof input === "object" &&
		"query" in input &&
		typeof input.query === "string"
			? input.query
			: "…";

	return (
		<text fg={theme.colors.tool}>
			{`Searching ${query} · ${call.state} · ${width}x${height}`}
		</text>
	);
};

const LookupResult: PluginToolResultRenderer = ({
	expanded,
	height,
	result,
	theme,
	width,
}) => {
	if (result.type === "failure") {
		return <text fg={theme.colors.error}>{result.errorText}</text>;
	}

	const output =
		typeof result.output === "string"
			? result.output
			: (JSON.stringify(result.output) ?? "");
	return (
		<box flexDirection="column" width="100%">
			<text fg={theme.colors.text}>
				{expanded
					? output
					: `${output.slice(0, 48)}${output.length > 48 ? "…" : ""}`}
			</text>
			<text fg={theme.colors.textMuted}>
				{`Ctrl+O ${expanded ? "collapses" : "expands"} · ${width}x${height}`}
			</text>
		</box>
	);
};

const pluginToolRendererExample: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "tool_renderer_example" });
	plugin.registerTool({
		name: "lookup",
		description: "Look up a short answer and its source.",
		inputSchema: z.object({ query: z.string() }),
		renderCall: LookupCall,
		renderResult: LookupResult,
		handler: async ({ query }) => ({
			output: {
				answer: `Answer for ${query}`,
				source: "example index",
			},
			type: "success",
		}),
	});
};

export default pluginToolRendererExample;
