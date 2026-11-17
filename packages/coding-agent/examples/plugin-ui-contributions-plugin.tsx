import type {
	PluginFactory,
	PluginUIFooterComponent,
	PluginUIHeaderComponent,
} from "@wincode/coding-agent";

const ProjectHeader: PluginUIHeaderComponent = ({ theme, width }) => (
	<box paddingX={1} width="100%">
		<text fg={theme.colors.primary}>{`Issue tracker · ${width} columns`}</text>
	</box>
);

const ProjectFooter: PluginUIFooterComponent = ({
	branch,
	statuses,
	theme,
}) => (
	<box flexDirection="column" paddingX={1} width="100%">
		<text fg={theme.colors.textMuted}>{branch ?? "No branch detected"}</text>
		{statuses.map((status) => (
			<text
				fg={theme.colors.textMuted}
				key={`${status.pluginId}:${status.key}`}
			>
				{`${status.pluginId}/${status.key}: ${status.value}`}
			</text>
		))}
	</box>
);

const pluginUIContributionsPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "issue_tracker_ui" });

	plugin.registerCommand({
		description:
			"Show issue-tracker status and presentation in the current Session.",
		name: "show-issue-ui",
		handler: ({ ui }) => {
			ui.setStatus("sync", "Issue tracker connected");
			ui.setWidget("issue", ["Open issues: 4", "Reviews waiting: 2"]);
			ui.setWidget("sync-detail", ["Last checked just now"], {
				placement: "belowEditor",
			});

			const header = ui.setHeader(ProjectHeader);
			const footer = ui.setFooter(ProjectFooter);
			if (!(header.success && footer.success)) {
				return "Another Plugin currently owns the application header or footer.";
			}

			ui.setTitle("Wincode · Issue tracker");
			ui.setWorkingMessage("Checking issue status...");
			ui.setWorkingIndicator({ frames: ["·", "•", "●", "•"], intervalMs: 120 });
			ui.setHiddenThinkingLabel("Issue-tracker reasoning");
			ui.setToolsExpanded(!ui.getToolsExpanded());
			return "Issue-tracker UI contributions enabled.";
		},
	});

	plugin.registerCommand({
		description:
			"Clear this Plugin's status, widgets, chrome, and presentation controls.",
		name: "clear-issue-ui",
		handler: ({ ui }) => {
			ui.setStatus("sync", undefined);
			ui.setWidget("issue", undefined);
			ui.setWidget("sync-detail", undefined);
			ui.setHeader(undefined);
			ui.setFooter(undefined);
			ui.setTitle(undefined);
			ui.setWorkingMessage(undefined);
			ui.setWorkingIndicator(undefined);
			ui.setHiddenThinkingLabel(undefined);
			ui.setWorkingVisible(true);
			ui.setToolsExpanded(false);
			return "Issue-tracker UI contributions cleared.";
		},
	});
};

export default pluginUIContributionsPlugin;
