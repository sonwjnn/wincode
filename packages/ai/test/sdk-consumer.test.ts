import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const coreConsumerPath = fileURLToPath(
	new URL("./sdk-node-consumer.mjs", import.meta.url)
);
const openAIConsumerPath = fileURLToPath(
	new URL("./sdk-openai-node-consumer.mjs", import.meta.url)
);
const anthropicConsumerPath = fileURLToPath(
	new URL("./sdk-anthropic-node-consumer.mjs", import.meta.url)
);

const runConsumer = async (
	runtime: string,
	consumerPath: string,
	label: string
): Promise<void> => {
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

test("core-only external SDK consumer imports and streams under Node", async () => {
	await runConsumer("node", coreConsumerPath, "core-only consumer");
});

test("core-only external SDK consumer imports and streams under Bun", async () => {
	await runConsumer(process.execPath, coreConsumerPath, "core-only consumer");
});

test("OpenAI-factory external consumer imports and chats under Node", async () => {
	await runConsumer("node", openAIConsumerPath, "OpenAI consumer");
});

test("OpenAI-factory external consumer imports and chats under Bun", async () => {
	await runConsumer(process.execPath, openAIConsumerPath, "OpenAI consumer");
});

test("Anthropic-factory external consumer imports and chats under Node", async () => {
	await runConsumer("node", anthropicConsumerPath, "Anthropic consumer");
});

test("Anthropic-factory external consumer imports and chats under Bun", async () => {
	await runConsumer(
		process.execPath,
		anthropicConsumerPath,
		"Anthropic consumer"
	);
});
