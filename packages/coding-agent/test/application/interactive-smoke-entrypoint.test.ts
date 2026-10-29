import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProviderSdkCredentialStore } from "../../modules/providers/provider-stores";
import { resolveUserDataDir } from "../../shared/paths/user-data-dir";

const root = path.resolve(import.meta.dir, "../../../..");
const posixTest = test.skipIf(process.platform === "win32");

posixTest(
	"invoking the live launcher directly cannot bypass billable approval",
	async () => {
		const child = Bun.spawn(
			[
				"bash",
				path.join(root, "scripts/test-support/interactive-smoke-launcher.sh"),
			],
			{
				env: { PATH: process.env.PATH ?? "", WINCODE_SMOKE_LIVE: "1" },
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [status, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("requires explicit billable approval");
	}
);

posixTest(
	"live credential staging copies only the selected configured Provider into the isolated auth store",
	async () => {
		const temporary = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-live-stage-")
		);
		try {
			const sourceHome = path.join(temporary, "source-home");
			const isolatedHome = path.join(temporary, "isolated-home");
			const sourceData = path.join(temporary, "source-data");
			const isolatedData = path.join(temporary, "isolated-data");
			const openaiCredential = {
				kind: "api-key",
				apiKey: "offline-test-only",
			};
			const anthropicCredential = {
				kind: "api-key",
				apiKey: "must-not-be-copied",
			};
			const sourceStore = createProviderSdkCredentialStore({
				userDataDir: resolveUserDataDir(
					{ XDG_DATA_HOME: sourceData },
					sourceHome
				),
			});
			await sourceStore.modify("openai", () => openaiCredential);
			await sourceStore.modify("anthropic", () => anthropicCredential);
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					path.join(
						root,
						"scripts/test-support/stage-live-smoke-credential.ts"
					),
				],
				{
					env: {
						HOME: sourceHome,
						PATH: process.env.PATH ?? "",
						WINCODE_SMOKE_HOME: isolatedHome,
						WINCODE_SMOKE_ISOLATED_XDG_DATA_HOME: isolatedData,
						WINCODE_SMOKE_MODEL: "openai/test-model",
						WINCODE_SMOKE_SOURCE_HOME: sourceHome,
						WINCODE_SMOKE_SOURCE_XDG_DATA_HOME: sourceData,
					},
					stdout: "pipe",
					stderr: "pipe",
				}
			);
			const [status, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
			const isolatedStore = createProviderSdkCredentialStore({
				userDataDir: resolveUserDataDir(
					{ XDG_DATA_HOME: isolatedData },
					isolatedHome
				),
			});
			expect(await isolatedStore.read("openai")).toEqual(openaiCredential);
			expect(await isolatedStore.read("anthropic")).toBeUndefined();
			expect(await sourceStore.read("openai")).toEqual(openaiCredential);
			expect(await sourceStore.read("anthropic")).toEqual(anthropicCredential);
		} finally {
			await fs.rm(temporary, { force: true, recursive: true });
		}
	}
);

posixTest(
	"live preparation uses the staged Provider credential and configures a no-tool smoke agent without a Provider request",
	async () => {
		const temporary = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-live-prepare-")
		);
		try {
			const home = path.join(temporary, "home");
			const data = path.join(temporary, "data");
			const workspace = path.join(temporary, "workspace");
			const credential = { kind: "api-key", apiKey: "offline-test-only" };
			await createProviderSdkCredentialStore({
				userDataDir: resolveUserDataDir({ XDG_DATA_HOME: data }, home),
			}).modify("openai", () => credential);
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					path.join(root, "scripts/test-support/prepare-live-smoke.ts"),
				],
				{
					env: {
						HOME: home,
						PATH: process.env.PATH ?? "",
						WINCODE_SMOKE_MODEL: "openai/test-model",
						WINCODE_SMOKE_WORKSPACE: workspace,
						XDG_DATA_HOME: data,
					},
					stdout: "pipe",
					stderr: "pipe",
				}
			);
			const [status, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
			expect(
				await createProviderSdkCredentialStore({
					userDataDir: resolveUserDataDir({ XDG_DATA_HOME: data }, home),
				}).read("openai")
			).toEqual(credential);
			expect(
				await Bun.file(path.join(workspace, ".wincode/settings.json")).json()
			).toMatchObject({
				agents: { "live-smoke": { model: "openai/test-model", tools: [] } },
			});
		} finally {
			await fs.rm(temporary, { force: true, recursive: true });
		}
	}
);

posixTest(
	"live smoke refuses to start without explicit billable approval and model selection",
	async () => {
		const child = Bun.spawn(
			["bash", path.join(root, "scripts/interactive-smoke.sh"), "--live"],
			{
				env: { PATH: process.env.PATH ?? "" },
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [status, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain(
			"Live smoke requires --approve-billable and --model"
		);
	}
);

posixTest(
	"live smoke refuses an approved invocation without an explicit Provider/model",
	async () => {
		const child = Bun.spawn(
			[
				"bash",
				path.join(root, "scripts/interactive-smoke.sh"),
				"--live",
				"--approve-billable",
			],
			{
				env: { PATH: process.env.PATH ?? "" },
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [status, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("--model provider/model");
	}
);

posixTest(
	"binary smoke rejects relative executable paths before starting a terminal",
	async () => {
		const child = Bun.spawn(
			[
				"bash",
				path.join(root, "scripts/interactive-smoke.sh"),
				"--binary",
				"./test.sh",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [status, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("absolute executable binary path");
	}
);

posixTest(
	"smoke launcher dispatches a supplied executable outside the checkout with isolated auth and exit status",
	async () => {
		const temporary = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-binary-smoke-")
		);
		try {
			const binary = path.join(temporary, "release binary");
			const report = path.join(temporary, "report");
			await Bun.write(
				binary,
				`#!/bin/sh\nprintf '%s\\n' "$PWD" "$HOME" "$WINCODE_TEST_SESSION_INDEX_DIR" "\${OPENAI_API_KEY-unset}" "$@" > '${report}'\nexit 17\n`
			);
			await fs.chmod(binary, 0o700);
			const child = Bun.spawn(
				[
					"bash",
					path.join(root, "scripts/test-support/interactive-smoke-launcher.sh"),
				],
				{
					env: {
						...process.env,
						WINCODE_SMOKE_BINARY: binary,
						WINCODE_SMOKE_LIVE: "0",
						OPENAI_API_KEY: "must-not-leak",
						WINCODE_SMOKE_HOME: "",
						WINCODE_SMOKE_BUN: "",
					},
					stdout: "pipe",
					stderr: "pipe",
				}
			);
			const [status, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect({ status, stderr }).toEqual({ status: 17, stderr: "" });
			const [workspace, home, index, credential, ...args] = (
				await Bun.file(report).text()
			)
				.trim()
				.split("\n");
			expect(workspace).not.toStartWith(root);
			expect(credential).toBe("unset");
			expect(index).toBe(path.join(home ?? "", "session-indexes"));
			expect(args).toContain("--plugin");
			await expect(fs.stat(home ?? "")).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await fs.rm(temporary, { force: true, recursive: true });
		}
	}
);
