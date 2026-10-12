import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const consumerPath = fileURLToPath(
	new URL("./sdk-openai-compatible-node-consumer.mjs", import.meta.url)
);

const runConsumer = async (runtime: string, label: string): Promise<void> => {
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
			`${runtime} ${label} failed (exit ${exitCode}).\n${stdout}${stderr}`
		);
	}
};

test("external DeepSeek and OpenRouter SDK consumer works under Node", async () => {
	await runConsumer("node", "provider consumer");
});

test("external DeepSeek and OpenRouter SDK consumer works under Bun", async () => {
	await runConsumer(process.execPath, "provider consumer");
});
