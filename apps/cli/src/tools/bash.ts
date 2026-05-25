import { spawn } from "node:child_process";
import type { BashInput, BashOutput } from "@wincode/tools";
import { WORKSPACE } from "./resolve-within-workspace";

const MAX_OUTPUT_LENGTH = 20_000;

const truncateOutput = (output: string) =>
	output.length > MAX_OUTPUT_LENGTH
		? `${output.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`
		: output;

export const runBashTool = async (input: BashInput): Promise<BashOutput> => {
	const proc = spawn("bash", ["-lc", input.command], {
		cwd: WORKSPACE,
	});
	let stdout = "";
	let stderr = "";
	const timeout = setTimeout(() => proc.kill(), input.timeoutMs ?? 30_000);

	proc.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});

	proc.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			proc.on("error", reject);
			proc.on("close", (code) => resolve(code ?? 1));
		});

		return {
			exitCode,
			stderr: truncateOutput(stderr),
			stdout: truncateOutput(stdout),
		};
	} finally {
		clearTimeout(timeout);
	}
};
