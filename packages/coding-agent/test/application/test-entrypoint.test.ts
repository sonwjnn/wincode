import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");

type TestReport = Readonly<{
	args: string[];
	cwd: string;
	environment: Record<string, string>;
}>;

const runEntrypoint = async (exitCode: number): Promise<void> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-test-entry-"));
	try {
		const home = path.join(root, "real-home");
		const checkout = path.join(root, "checkout with spaces");
		const bin = path.join(root, "bin");
		await fs.mkdir(bin);
		await fs.mkdir(checkout);
		await fs.mkdir(home);
		const auth = path.join(home, ".wincode/auth.json");
		await Bun.write(auth, "user auth must stay untouched");
		await fs.symlink(process.execPath, path.join(bin, "bun"));
		await fs.copyFile(
			path.join(repositoryRoot, "test.sh"),
			path.join(checkout, "test.sh")
		);
		await Bun.write(
			path.join(checkout, "package.json"),
			JSON.stringify({ scripts: { test: "bun --no-env-file probe.ts" } })
		);
		await Bun.write(
			path.join(checkout, ".env"),
			"DOTENV_SECRET=must-not-load\nANTHROPIC_API_KEY=dotenv-secret\n"
		);
		await Bun.write(
			path.join(checkout, "probe.ts"),
			`
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSessionDatabasePath } from ${JSON.stringify(path.join(repositoryRoot, "packages/coding-agent/modules/sessions/storage/path.ts"))};
const indexDirectory = process.env.WINCODE_TEST_SESSION_INDEX_DIR;
if (!indexDirectory || !path.isAbsolute(indexDirectory)) throw new Error("Session indexes must have an isolated absolute directory.");
resolveSessionDatabasePath(path.join(process.env.HOME!, "test.db"));
if (!fs.readdirSync(indexDirectory).some(name => name.endsWith(".database-path"))) throw new Error("Session index escaped the test directory.");
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), environment: process.env }));
process.exit(${exitCode});
`
		);
		const child = Bun.spawn(
			[path.join(checkout, "test.sh"), "--package", "coding-agent"],
			{
				cwd: root,
				env: {
					...process.env,
					HOME: home,
					TMPDIR: "real-home",
					PATH: "bin:/usr/bin:/bin",
					ANTHROPIC_API_KEY: "inherited-secret",
					CUSTOM_PROVIDER_TOKEN: "unknown-provider-secret",
					WINCODE_LOCAL_DB_PATH: path.join(home, "production.db"),
					USER: "test-account",
					LOGNAME: "test-account",
				},
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [stdout, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ status, stderr: status === exitCode ? "" : stderr }).toEqual({
			status: exitCode,
			stderr: "",
		});
		const report = JSON.parse(
			stdout.trim().split("\n").at(-1) ?? ""
		) as TestReport;
		expect(report.cwd).toBe(await fs.realpath(checkout));
		expect(report.args).toEqual(["--package", "coding-agent"]);
		expect(report.environment.ANTHROPIC_API_KEY).toBeUndefined();
		expect(report.environment.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
		expect(report.environment.DOTENV_SECRET).toBeUndefined();
		expect(report.environment.WINCODE_LOCAL_DB_PATH).toBeUndefined();
		expect(report.environment.USER).toBe("test-account");
		expect(report.environment.LOGNAME).toBe("test-account");
		expect(report.environment.HOME).not.toBe(home);
		for (const name of [
			"HOME",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_CACHE_HOME",
			"APPDATA",
			"LOCALAPPDATA",
			"TMPDIR",
			"WINCODE_TEST_SESSION_INDEX_DIR",
		]) {
			const directory = report.environment[name];
			expect(directory).toBeDefined();
			expect(directory).not.toBe("");
			await expect(fs.stat(directory ?? "")).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
		expect(await Bun.file(auth).text()).toBe("user auth must stay untouched");
		expect(await fs.readdir(home)).toEqual([".wincode"]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
};

test("test.sh isolates credentials and Session indexes without changing the caller's auth", () =>
	runEntrypoint(0));

test("test.sh preserves test failures and removes temporary data on failure", () =>
	runEntrypoint(23));

test("test.sh does not reload checkout dotenv credentials in Default test processes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-test-dotenv-"));
	try {
		await Bun.write(
			path.join(root, ".env"),
			"CUSTOM_PROVIDER_TOKEN=dotenv-secret\n"
		);
		await Bun.write(
			path.join(root, "packages/probe/test/environment.test.ts"),
			`
import { expect, test } from "bun:test";
test("Default tests cannot see dotenv credentials", () => {
  expect(process.env.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
});
`
		);
		const child = Bun.spawn(
			[path.join(repositoryRoot, "test.sh"), "--root", root],
			{
				cwd: os.tmpdir(),
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({
			exitCode,
			failure: exitCode === 0 ? "" : stdout + stderr,
		}).toEqual({ exitCode: 0, failure: "" });
		expect(stdout).toContain("Executed Default test files: 1");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
