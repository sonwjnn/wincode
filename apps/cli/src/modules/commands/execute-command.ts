import type {
	AgentsAdapter,
	CompactAdapter,
	CompactionAdapter,
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModelsAdapter,
	NewAdapter,
	SkillsAdapter,
	VariantsAdapter,
} from "./adapters";
import type { CommandSpec } from "./commands";

export type AdapterMap = {
	agents: AgentsAdapter;
	compact?: CompactAdapter;
	compaction?: CompactionAdapter;
	connect: ConnectAdapter;
	dialog: DialogAdapter;
	exit: ExitAdapter;
	models: ModelsAdapter;
	new: NewAdapter;
	skills: SkillsAdapter;
	variants: VariantsAdapter;
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
			case "compaction":
				if (!adapters.compaction) {
					throw new Error("Compaction settings are unavailable in this view.");
				}
				return adapters.compaction.execute(spec);
			case "dialog":
				adapters.dialog.execute(spec);
				break;
			case "models":
				return adapters.models.execute(spec);
			case "skills":
				adapters.skills.execute(spec);
				break;
			case "variants":
				adapters.variants.execute(spec);
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
