import type {
	AgentsAdapter,
	CompactAdapter,
	ConnectAdapter,
	DialogAdapter,
	EffortAdapter,
	ExitAdapter,
	ModelsAdapter,
	NewAdapter,
	SettingsAdapter,
} from "./adapters";
import type { CommandSpec } from "./commands";

export type AdapterMap = {
	agents: AgentsAdapter;
	compact?: CompactAdapter;
	connect: ConnectAdapter;
	dialog: DialogAdapter;
	effort?: EffortAdapter;
	exit: ExitAdapter;
	models: ModelsAdapter;
	new: NewAdapter;
	settings?: SettingsAdapter;
};

export function createCommandExecutor(adapters: AdapterMap) {
	return function execute(spec: CommandSpec) {
		switch (spec.kind) {
			case "exit":
				adapters.exit.execute(spec);
				break;
			case "connect":
				return adapters.connect.execute(spec);
			case "new":
				adapters.new.execute(spec);
				break;
			case "compact":
				if (!adapters.compact) {
					throw new Error("Compaction is unavailable in this view.");
				}
				return adapters.compact.execute(spec);
			case "settings":
				if (!adapters.settings) {
					throw new Error("Settings are unavailable in this view.");
				}
				return adapters.settings.execute(spec);
			case "dialog":
				adapters.dialog.execute(spec);
				break;
			case "models":
				return adapters.models.execute(spec);
			case "effort":
				if (!adapters.effort) {
					throw new Error("Effort selection is unavailable in this view.");
				}
				adapters.effort.execute(spec);
				break;
			case "agents":
				adapters.agents.execute(spec);
				break;
			default: {
				const _exhaustive: never = spec;
				return _exhaustive;
			}
		}
	};
}
