import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { createProviderSdkCredentialStore } from "../../modules/providers/provider-stores";
import { resolveUserDataDir } from "../../shared/paths/user-data-dir";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");

test.skipIf(process.platform === "win32")(
	"live smoke displays its Agent-pinned model instead of the fallback before sending any prompt",
	async () => {
		const home = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-live-model-")
		);
		const socket = `wincode-live-model-${crypto.randomUUID()}`;
		const data = path.join(home, "data");
		try {
			await createProviderSdkCredentialStore({
				userDataDir: resolveUserDataDir({ XDG_DATA_HOME: data }, home),
			}).modify("openai", () => ({
				kind: "api-key",
				apiKey: "offline-test-only",
			}));
			const launcher = path.join(
				repositoryRoot,
				"scripts/test-support/interactive-smoke-launcher.sh"
			);
			await $`tmux -L ${socket} -f /dev/null new-session -d -s smoke -x 100 -y 26 -e ${`WINCODE_SMOKE_HOME=${home}`} -e ${`WINCODE_SMOKE_BUN=${process.execPath}`} -e WINCODE_SMOKE_LIVE=1 -e WINCODE_SMOKE_APPROVED=1 -e WINCODE_SMOKE_MODEL=openai/gpt-6-luna ${launcher}`
				.cwd(repositoryRoot)
				.quiet();
			const deadline = Date.now() + 10_000;
			let frame = "";
			while (Date.now() < deadline) {
				const capture =
					await $`tmux -L ${socket} capture-pane -t smoke -p`.quiet();
				frame = capture.text();
				if (
					frame.includes("The Session Writer OS lock could not be established")
				) {
					throw new Error(
						"NOT VERIFIED: Session Writer OS lock could not be established."
					);
				}
				if (
					frame.includes("Ask anything...") &&
					frame.includes("openai/gpt-6-luna")
				) {
					break;
				}
				await Bun.sleep(100);
			}
			expect(frame).toContain("Ask anything...");
			expect(frame).toContain("openai/gpt-6-luna");
			expect(frame).not.toContain("openai/gpt-5.6-luna");
		} finally {
			await $`tmux -L ${socket} kill-server`.quiet().nothrow();
			await removeTemporaryDirectory(home);
		}
	},
	20_000
);
