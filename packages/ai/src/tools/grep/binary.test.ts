import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	downloadRipgrepBinary,
	getRipgrepPlatformConfig,
	RIPGREP_VERSION,
	type RipgrepArchiveExtractor,
	type RipgrepBinaryOptions,
	RipgrepDownloadError,
	type RipgrepFetch,
	type RipgrepPlatformConfig,
	RipgrepUnavailableError,
	resolveRipgrepCacheDirectory,
	resolveRipgrepExecutable,
} from "./binary";

const TEST_PLATFORM = "test-platform";
const TEST_ARCH = "test-arch";

const makeTemporaryDirectory = async (): Promise<string> =>
	mkdtemp(path.join(tmpdir(), "wincode-ripgrep-test-"));

const makeTestConfig = (sha256: string): RipgrepPlatformConfig => ({
	target: "test-target",
	extension: "tar.gz",
	sha256,
});

const makeTestOptions = (
	cacheDirectory: string,
	config: RipgrepPlatformConfig,
	overrides: Partial<RipgrepBinaryOptions> = {}
): RipgrepBinaryOptions => ({
	arch: TEST_ARCH,
	cacheDirectory,
	environment: {},
	findSystemExecutable: async () => undefined,
	platform: TEST_PLATFORM,
	platformConfigResolver: () => config,
	...overrides,
});

describe("ripgrep binary resolver", () => {
	test("maps supported platforms to official release targets", () => {
		expect(getRipgrepPlatformConfig("darwin", "arm64")).toEqual({
			target: "aarch64-apple-darwin",
			extension: "tar.gz",
			sha256:
				"378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
		});
		expect(getRipgrepPlatformConfig("freebsd", "x64")).toBeUndefined();
	});

	test("uses platform-appropriate cache directories", () => {
		expect(
			resolveRipgrepCacheDirectory({
				environment: {},
				homeDirectory: "/home/test",
				platform: "darwin",
			})
		).toBe("/home/test/Library/Caches/wincode");
		expect(
			resolveRipgrepCacheDirectory({
				environment: {},
				homeDirectory: "/home/test",
				platform: "linux",
			})
		).toBe("/home/test/.cache/wincode");
		expect(
			resolveRipgrepCacheDirectory({
				environment: { LOCALAPPDATA: "/local/app-data" },
				homeDirectory: "/home/test",
				platform: "win32",
			})
		).toBe("/local/app-data/wincode");
	});

	test("downloads, verifies, installs, and reuses the cached binary", async () => {
		const cacheDirectory = await makeTemporaryDirectory();
		try {
			const archive = Buffer.from("test ripgrep archive");
			const checksum = createHash("sha256").update(archive).digest("hex");
			const config = makeTestConfig(checksum);
			let fetchCount = 0;
			let extractCount = 0;
			const fetchImpl: RipgrepFetch = async () => {
				fetchCount += 1;
				return new Response(archive, {
					headers: { "content-length": String(archive.byteLength) },
					status: 200,
				});
			};
			const extractArchive: RipgrepArchiveExtractor = async (
				_archivePath,
				extractionDirectory,
				extractionConfig
			) => {
				extractCount += 1;
				const extractedDirectory = path.join(
					extractionDirectory,
					`ripgrep-${RIPGREP_VERSION}-${extractionConfig.target}`
				);
				await mkdir(extractedDirectory, { recursive: true });
				const extractedPath = path.join(extractedDirectory, "rg");
				await writeFile(extractedPath, "fake ripgrep");
				await chmod(extractedPath, 0o755);
			};
			const options = makeTestOptions(cacheDirectory, config, {
				extractArchive,
				fetchImpl,
			});

			const firstPath = await resolveRipgrepExecutable(options);
			const secondPath = await resolveRipgrepExecutable(options);

			expect(firstPath).toBe(secondPath);
			expect(await readFile(firstPath, "utf8")).toBe("fake ripgrep");
			expect(fetchCount).toBe(1);
			expect(extractCount).toBe(1);
		} finally {
			await rm(cacheDirectory, { force: true, recursive: true });
		}
	});

	test("rejects an archive whose checksum does not match the pinned digest", async () => {
		const cacheDirectory = await makeTemporaryDirectory();
		try {
			const config = makeTestConfig("0".repeat(64));
			const options = makeTestOptions(cacheDirectory, config, {
				fetchImpl: async () =>
					new Response("tampered archive", { status: 200 }),
			});

			await expect(downloadRipgrepBinary(options)).rejects.toBeInstanceOf(
				RipgrepDownloadError
			);
		} finally {
			await rm(cacheDirectory, { force: true, recursive: true });
		}
	});

	test("uses an explicitly configured executable without downloading", async () => {
		const executable = "/custom/rg";
		await expect(
			resolveRipgrepExecutable({
				environment: { WINCODE_RIPGREP_PATH: executable },
				findSystemExecutable: async () => {
					throw new Error("system lookup should not run");
				},
			})
		).resolves.toBe(executable);
	});

	test("reports unsupported platforms as unavailable", async () => {
		const cacheDirectory = await makeTemporaryDirectory();
		try {
			await expect(
				downloadRipgrepBinary({
					arch: "x64",
					cacheDirectory,
					platform: "freebsd",
				})
			).rejects.toBeInstanceOf(RipgrepUnavailableError);
		} finally {
			await rm(cacheDirectory, { force: true, recursive: true });
		}
	});
});
