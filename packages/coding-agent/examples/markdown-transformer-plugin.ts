import type { PluginFactory } from "@wincode/coding-agent";

const markdownTransformerExample: PluginFactory = (api) => {
	api.definePlugin({ id: "markdown_transformer_example" });
	api.registerMarkdownTransformer((markdown, { isStreaming, messageType }) => {
		if (isStreaming || messageType === "assistant-thinking") {
			return markdown;
		}
		return markdown.replaceAll("-->", "→");
	});
};

export default markdownTransformerExample;
