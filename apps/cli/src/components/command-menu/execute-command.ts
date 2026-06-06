import type {
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
} from "./adapters";
import type { CommandSpec } from "./commands";

export type AdapterMap = {
	exit: ExitAdapter;
	new: NewAdapter;
	dialog: DialogAdapter;
	models: ModelsAdapter;
	mode: ModeAdapter;
	unavailable: UnavailableAdapter;
};

export function createCommandExecutor(adapters: AdapterMap) {
	return function execute(
		spec: CommandSpec,
		onError?: (error: unknown) => void
	) {
		try {
			switch (spec.kind) {
				case "exit":
					return adapters.exit.execute(spec);
				case "new":
					return adapters.new.execute(spec);
				case "dialog":
					return adapters.dialog.execute(spec);
				case "models":
					return adapters.models.execute(spec);
				case "mode":
					return adapters.mode.execute(spec);
				case "unavailable":
					return adapters.unavailable.execute(spec);
				default: {
					const _exhaustive: never = spec;
					return _exhaustive;
				}
			}
		} catch (error) {
			if (onError) {
				onError(error);
			}
		}
	};
}
