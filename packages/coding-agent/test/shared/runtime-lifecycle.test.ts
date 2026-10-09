import { expect, test } from "bun:test";
import { createInteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";

test("application cleanup waits for replacement before shutting down its runtime", async () => {
	const lifecycle = createInteractiveRuntimeLifecycle();
	const replacementStarted = Promise.withResolvers<void>();
	const allowReplacementToFinish = Promise.withResolvers<void>();
	let activeRuntime = "previous";
	let runtimeSeenByCleanup: string | undefined;
	lifecycle.setCleanup(async () => {
		runtimeSeenByCleanup = activeRuntime;
	});

	const replacement = lifecycle.withRuntimeReplacement(async () => {
		replacementStarted.resolve();
		await allowReplacementToFinish.promise;
		activeRuntime = "replacement";
		return activeRuntime;
	});
	await replacementStarted.promise;
	const cleanup = lifecycle.runCleanup();

	expect(runtimeSeenByCleanup).toBeUndefined();
	allowReplacementToFinish.resolve();
	await expect(replacement).resolves.toBe("replacement");
	await cleanup;
	expect(runtimeSeenByCleanup).toBe("replacement");
});
