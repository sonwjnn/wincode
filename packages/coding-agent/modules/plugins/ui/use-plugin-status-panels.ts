import { useEffect, useMemo, useState } from "react";
import { getInteractivePluginRuntime } from "@/shared/runtime-context";
import type { PluginStatusPanelSnapshot } from "../public";
import type { PluginRuntime, PluginStatusPanelDescriptor } from "../runtime";

export type PluginStatusPanelView = Readonly<{
	panel: PluginStatusPanelDescriptor;
	snapshot: PluginStatusPanelSnapshot;
}>;

export const usePluginStatusPanels = (): readonly PluginStatusPanelView[] => {
	const runtime: PluginRuntime | undefined = getInteractivePluginRuntime();
	const panels = useMemo(() => runtime?.getStatusPanels() ?? [], [runtime]);
	const [, setRevision] = useState(0);

	useEffect(() => {
		const unsubscribe = panels.map((panel) =>
			panel.subscribe(() => setRevision((revision) => revision + 1))
		);
		return () => {
			for (const stop of unsubscribe) {
				stop();
			}
		};
	}, [panels]);

	return panels.map((panel) => ({
		panel,
		snapshot: panel.getSnapshot(),
	}));
};
