import type { ExecutionMode } from "@/shared/execution-mode";

export class HeadlessProviderSdkRequiredError extends Error {
	readonly executionMode: Exclude<ExecutionMode, "interactive">;

	constructor(executionMode: Exclude<ExecutionMode, "interactive">) {
		super(
			`${executionMode} Mode requires the Provider SDK runtime; legacy Catalog execution is disabled. Connect the Provider in Interactive Mode, then retry.`
		);
		this.name = "HeadlessProviderSdkRequiredError";
		this.executionMode = executionMode;
	}
}
