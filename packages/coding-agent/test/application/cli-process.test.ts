import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCliProcessLauncher } from "../../bin/cli-process";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

test("mode launcher routes to the correct entrypoint and forwards CLI process state", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "wincode-cli-process-")
	);
	temporaryDirectories.push(directory);
	const canonicalDirectory = await realpath(directory);
	const resultPath = path.join(directory, "result.json");
	const executionEntrypoint = path.join(directory, "execution.ts");
	const interactiveEntrypoint = path.join(directory, "interactive.ts");
	const executionArgs = ["--mode", "rpc"];
	const interactiveArgs = ["--mode", "interactive", "--trust-project"];
	const writeEntrypoint = async (
		filePath: string,
		entrypoint: string,
		exitCode: number
	): Promise<void> => {
		await Bun.write(
			filePath,
			[
				`await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({`,
				`\tentrypoint: ${JSON.stringify(entrypoint)},`,
				"\targs: process.argv.slice(2),",
				"\tcwd: process.cwd(),",
				"}));",
				`process.exitCode = ${exitCode};`,
			].join("\n")
		);
	};
	await Promise.all([
		writeEntrypoint(executionEntrypoint, "execution", 17),
		writeEntrypoint(interactiveEntrypoint, "interactive", 23),
	]);
	const launch = createCliProcessLauncher({
		execution: executionEntrypoint,
		interactive: interactiveEntrypoint,
	});

	const executionExitCode = await launch({
		args: executionArgs,
		cwd: directory,
		mode: "rpc",
	});
	expect(executionExitCode).toBe(17);
	expect(await Bun.file(resultPath).json()).toEqual({
		entrypoint: "execution",
		args: executionArgs,
		cwd: canonicalDirectory,
	});

	const interactiveExitCode = await launch({
		args: interactiveArgs,
		cwd: directory,
		mode: "interactive",
	});
	expect(interactiveExitCode).toBe(23);
	expect(await Bun.file(resultPath).json()).toEqual({
		entrypoint: "interactive",
		args: interactiveArgs,
		cwd: canonicalDirectory,
	});
});
