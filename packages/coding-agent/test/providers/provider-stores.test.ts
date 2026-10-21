import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ChatEvent,
	type CredentialStore,
	createProviderCollection,
} from "@wincode/ai";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
	getProviderSdkStores,
} from "@/modules/providers/provider-stores";

const saveCredential = (
	store: CredentialStore,
	id: string,
	credential: unknown
) => store.modify(id, () => credential);

test("separate Home and Host compositions share app-owned Provider stores", () => {
	const userDataDir = path.join(
		os.tmpdir(),
		`wincode-store-sharing-${crypto.randomUUID()}`
	);
	expect(getProviderSdkStores({ userDataDir })).toBe(
		getProviderSdkStores({ userDataDir })
	);
});

test("Provider credentials and Known Models survive restart without leaking to another user", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-stores-")
	);
	const one = path.join(root, "one");
	const two = path.join(root, "two");
	try {
		await saveCredential(
			createProviderSdkCredentialStore({ userDataDir: one }),
			"openrouter",
			{
				kind: "api-key",
				apiKey: "synthetic-key",
			}
		);
		const models = [
			{ modelId: "model", protocolId: "test", providerId: "openrouter" },
		];
		await createProviderSdkModelStore({ userDataDir: one }).set(
			"openrouter",
			models,
			{ signal: undefined }
		);
		expect(
			await createProviderSdkCredentialStore({ userDataDir: one }).list()
		).toEqual([{ providerId: "openrouter", type: "api-key" }]);
		expect(
			await createProviderSdkCredentialStore({ userDataDir: two }).read(
				"openrouter"
			)
		).toBeUndefined();
		expect(
			await createProviderSdkModelStore({ userDataDir: one }).get("openrouter")
		).toEqual(models);
		expect(
			await createProviderSdkModelStore({ userDataDir: two }).get("openrouter")
		).toBeUndefined();
		const controller = new AbortController();
		controller.abort(new DOMException("cancelled", "AbortError"));
		await expect(
			createProviderSdkCredentialStore({ userDataDir: one }).modify(
				"openrouter",
				() => ({ kind: "api-key" }),
				{ signal: controller.signal }
			)
		).rejects.toThrow("cancelled");
		expect(
			await createProviderSdkCredentialStore({ userDataDir: one }).read(
				"openrouter"
			)
		).toMatchObject({ apiKey: "synthetic-key" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("separate processes serialize Provider refreshes without losing a newer credential", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-lock-")
	);
	const store = createProviderSdkCredentialStore({ userDataDir: root });
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const ready = path.join(root, "child-ready");
	const childSource = `
import { createProviderSdkCredentialStore } from "./packages/coding-agent/modules/providers/provider-stores.ts";
const store = createProviderSdkCredentialStore({ userDataDir: process.env.TEST_AUTH_DIR });
await Bun.write(process.env.TEST_AUTH_READY, "ready");
await store.modify("openai", (credential) => ({ ...credential, revision: credential.revision + 1 }));
`;
	let child: Bun.Subprocess | undefined;
	try {
		await saveCredential(store, "openai", {
			kind: "oauth-session",
			revision: 0,
		});
		const first = store.modify("openai", async (credential) => {
			started.resolve();
			await finish.promise;
			return { ...(credential as object), revision: 1 };
		});
		await started.promise;
		child = Bun.spawn([process.execPath, "-e", childSource], {
			cwd: process.cwd(),
			env: { ...process.env, TEST_AUTH_DIR: root, TEST_AUTH_READY: ready },
			stderr: "pipe",
			stdout: "pipe",
		});
		for (
			let attempt = 0;
			attempt < 500 && !(await Bun.file(ready).exists());
			attempt += 1
		) {
			await Bun.sleep(10);
		}
		expect(await Bun.file(ready).exists()).toBe(true);
		finish.resolve();
		await first;
		expect(await child.exited).toBe(0);
		expect(await store.read("openai")).toMatchObject({ revision: 2 });
	} finally {
		finish.resolve();
		child?.kill();
		if (child !== undefined) {
			await child.exited;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a started refresh persists its replacement after its caller cancels", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-auth-refresh-")
	);
	try {
		const store = createProviderSdkCredentialStore({ userDataDir: root });
		await saveCredential(store, "openai", {
			kind: "oauth-session",
			revision: 0,
		});
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const controller = new AbortController();
		const refresh = store.modify(
			"openai",
			async () => {
				started.resolve();
				await finish.promise;
				return { kind: "oauth-session", revision: 1 };
			},
			{ signal: controller.signal }
		);
		await started.promise;
		controller.abort(new DOMException("caller cancelled", "AbortError"));
		finish.resolve();
		expect(await refresh).toMatchObject({ revision: 1 });
		expect(
			await createProviderSdkCredentialStore({ userDataDir: root }).read(
				"openai"
			)
		).toMatchObject({ revision: 1 });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("chat with a stored credential tightens an owned 0755 directory without manual chmod", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-auth-permissions-")
	);
	const userDataDir = path.join(root, "user");
	await fs.mkdir(userDataDir, { mode: 0o755 });
	await fs.chmod(userDataDir, 0o755);
	const store = createProviderSdkCredentialStore({ userDataDir });
	const sdk = createProviderCollection({ credentialStore: store });
	sdk.register({
		id: "openai",
		models: [
			{ modelId: "test-model", protocolId: "test", providerId: "openai" },
		],
		resolveAuthorization: ({ credential }) =>
			credential === undefined ? null : { authorization: "synthetic-auth" },
		async *streamChat() {
			yield { delta: "hello", type: "text-delta" };
			yield { type: "finish" };
		},
	});
	try {
		await saveCredential(store, "openai", {
			kind: "api-key",
			apiKey: "synthetic-key",
		});
		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "test-model",
			providerId: "openai",
		})) {
			events.push(event);
		}
		expect(events.at(-1)).toMatchObject({
			outcome: { status: "success" },
			type: "terminal",
		});
		expect((await fs.stat(userDataDir)).mode % 0o1000).toBe(0o700);
		expect(
			(await fs.stat(path.join(userDataDir, "auth.json"))).mode % 0o1000
		).toBe(0o600);
	} finally {
		await sdk.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a symlinked auth directory is rejected without changing its target", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-auth-symlink-")
	);
	const target = path.join(root, "target");
	const userDataDir = path.join(root, "user");
	await fs.mkdir(target, { mode: 0o755 });
	await fs.chmod(target, 0o755);
	await fs.symlink(target, userDataDir, "dir");
	try {
		await expect(
			saveCredential(
				createProviderSdkCredentialStore({ userDataDir }),
				"openai",
				{ kind: "api-key" }
			)
		).rejects.toThrow("Refusing insecure auth directory");
		expect((await fs.stat(target)).mode % 0o1000).toBe(0o755);
		expect(await Bun.file(path.join(target, "auth.json")).exists()).toBe(false);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
