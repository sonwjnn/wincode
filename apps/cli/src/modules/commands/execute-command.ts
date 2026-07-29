import type {
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	SkillsAdapter,
	VariantsAdapter,
} from "./adapters";
import type { CommandSpec } from "./commands";

export type AdapterMap = {
	exit: ExitAdapter;
	connect: ConnectAdapter;
	new: NewAdapter;
	dialog: DialogAdapter;
	models: ModelsAdapter;
	skills: SkillsAdapter;
	variants: VariantsAdapter;
	mode: ModeAdapter;
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
			case "mode":
				adapters.mode.execute(spec);
				break;
			default: {
				const _exhaustive: never = spec;
				return _exhaustive;
			}
		}
	};
}
