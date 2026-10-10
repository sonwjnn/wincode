import * as path from "node:path";
import type { DispatchProcessLauncher } from "../modules/application/dispatch";

type CliEntrypoints = Readonly<{
	execution: string;
	interactive: string;
}>;

const defaultEntrypoints: CliEntrypoints = {
	execution: path.join(import.meta.dir, "wincode-execution.ts"),
	interactive: path.join(import.meta.dir, "wincode-interactive.ts"),
};

// Isolate static mode and TUI imports from root-level help and version handling.
export const createCliProcessLauncher =
	(entrypoints: CliEntrypoints = defaultEntrypoints): DispatchProcessLauncher =>
	async ({ args, cwd, mode }) => {
		const entrypoint =
			mode === "interactive" ? entrypoints.interactive : entrypoints.execution;
		const child = Bun.spawn([process.execPath, "run", entrypoint, ...args], {
			cwd,
			stderr: "inherit",
			stdin: "inherit",
			stdout: "inherit",
		});
		return await child.exited;
	};
