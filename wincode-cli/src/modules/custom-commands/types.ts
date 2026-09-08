import type { BaseSpec } from "@/modules/commands/commands";

export type CustomCommandCandidate = {
	filePath: string;
	scope: "global" | "project";
};

export type CustomCommandSpec = BaseSpec & {
	kind: "custom";
	template: string;
};
