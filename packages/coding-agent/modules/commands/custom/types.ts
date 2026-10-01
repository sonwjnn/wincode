import type { BaseSpec } from "../types";

export type CustomCommandCandidate = {
	filePath: string;
	scope: "global" | "project";
};

export type CustomCommandSpec = BaseSpec & {
	kind: "custom";
	template: string;
};
