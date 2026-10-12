import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const consumerPath = fileURLToPath(
	new URL("./sdk-node-consumer.mjs", import.meta.url)
);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const runConsumer = async (runtime: string): Promise<void> => {
	const consumer = Bun.spawn([runtime, consumerPath], {
		cwd: packageRoot,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr, stdout] = await Promise.all([
		consumer.exited,
		new Response(consumer.stderr).text(),
		new Response(consumer.stdout).text(),
	]);

	if (exitCode !== 0) {
		throw new Error(
			`${runtime} external SDK consumer failed (exit ${exitCode}).\n${stdout}${stderr}`
		);
	}
};

test("external SDK consumer imports and streams under Node", async () => {
	await runConsumer("node");
});

test("external SDK consumer imports and streams under Bun", async () => {
	await runConsumer(process.execPath);
});
