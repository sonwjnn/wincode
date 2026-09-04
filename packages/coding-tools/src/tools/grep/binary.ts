import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	open,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { truncateUtf8 } from "../output-bounds";

export const RIPGREP_VERSION = "15.1.0";

const APP_NAME = "wincode";
const DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const EXTRACTION_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_MAX_BYTES = 8 * 1024;

type ArchiveExtension = "tar.gz" | "zip";

export type RipgrepPlatformConfig = {
	target: string;
	extension: ArchiveExtension;
	sha256: string;
};

const PLATFORM_CONFIGS: Readonly<Record<string, RipgrepPlatformConfig>> = {
	"arm64-darwin": {
		target: "aarch64-apple-darwin",
		extension: "tar.gz",
		sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
	},
	"arm64-linux": {
		target: "aarch64-unknown-linux-gnu",
		extension: "tar.gz",
		sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
	},
	"x64-darwin": {
		target: "x86_64-apple-darwin",
		extension: "tar.gz",
		sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
	},
	"x64-linux": {
		target: "x86_64-unknown-linux-musl",
		extension: "tar.gz",
		sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
	},
	"arm64-win32": {
		target: "aarch64-pc-windows-msvc",
		extension: "zip",
		sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
	},
	"ia32-win32": {
		target: "i686-pc-windows-msvc",
		extension: "zip",
		sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
	},
	"x64-win32": {
		target: "x86_64-pc-windows-msvc",
		extension: "zip",
		sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
	},
};

export class RipgrepUnavailableError extends Error {
	constructor(reason: string) {
		super(`ripgrep is unavailable: ${reason}`);
		this.name = "RipgrepUnavailableError";
	}
}

export class RipgrepDownloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RipgrepDownloadError";
	}
}

export type RipgrepFetch = (
	input: string | URL,
	init?: RequestInit
) => Promise<Response>;

export type RipgrepBinaryOptions = {
	arch?: string;
	cacheDirectory?: string;
	environment?: NodeJS.ProcessEnv;
	extractArchive?: RipgrepArchiveExtractor;
	fetchImpl?: RipgrepFetch;
	findSystemExecutable?: () => Promise<string | undefined>;
	homeDirectory?: string;
	platform?: string;
	platformConfigResolver?: (
		platform: string,
		arch: string
	) => RipgrepPlatformConfig | undefined;
};

export type RipgrepArchiveExtractor = (
	archivePath: string,
	extractionDirectory: string,
	config: RipgrepPlatformConfig
) => Promise<void>;

export const getRipgrepPlatformConfig = (
	platform: string = process.platform,
	arch: string = process.arch
): RipgrepPlatformConfig | undefined => PLATFORM_CONFIGS[`${arch}-${platform}`];

export const resolveRipgrepCacheDirectory = ({
	environment = process.env,
	homeDirectory = os.homedir(),
	platform = process.platform,
}: Pick<
	RipgrepBinaryOptions,
	"environment" | "homeDirectory" | "platform"
> = {}): string => {
	if (environment.WINCODE_RIPGREP_CACHE_DIR) {
		return environment.WINCODE_RIPGREP_CACHE_DIR;
	}

	if (platform === "darwin") {
		return path.join(homeDirectory, "Library", "Caches", APP_NAME);
	}

	if (platform === "win32") {
		return path.join(
			environment.LOCALAPPDATA ??
				environment.APPDATA ??
				path.join(homeDirectory, "AppData", "Local"),
			APP_NAME
		);
	}

	return path.join(
		environment.XDG_CACHE_HOME ?? path.join(homeDirectory, ".cache"),
		APP_NAME
	);
};

const getExecutableName = (platform: string): string =>
	platform === "win32" ? "rg.exe" : "rg";

const getArchiveFilename = (config: RipgrepPlatformConfig): string =>
	`ripgrep-${RIPGREP_VERSION}-${config.target}.${config.extension}`;

const getArchiveRoot = (config: RipgrepPlatformConfig): string =>
	`ripgrep-${RIPGREP_VERSION}-${config.target}`;

const getBinaryPaths = (options: RipgrepBinaryOptions = {}) => {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const config = (options.platformConfigResolver ?? getRipgrepPlatformConfig)(
		platform,
		arch
	);
	if (!config) {
		throw new RipgrepUnavailableError(
			`unsupported platform: ${arch}-${platform}`
		);
	}

	const platformKey = `${arch}-${platform}`;
	const cacheDirectory = path.join(
		options.cacheDirectory ??
			resolveRipgrepCacheDirectory({
				environment: options.environment,
				homeDirectory: options.homeDirectory,
				platform,
			}),
		"ripgrep",
		RIPGREP_VERSION,
		platformKey
	);
	const executableName = getExecutableName(platform);

	return {
		archiveFilename: getArchiveFilename(config),
		archiveRoot: getArchiveRoot(config),
		cacheDirectory,
		config,
		executableName,
		targetPath: path.join(cacheDirectory, executableName),
	};
};

const getErrorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return;
	}
	const code = error.code;
	return typeof code === "string" ? code : undefined;
};

const getErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isExecutableFile = async (
	filePath: string,
	platform: string
): Promise<boolean> => {
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) {
			return false;
		}
		if (platform !== "win32") {
			await access(filePath, fsConstants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
};

const findExecutableOnPath = async (
	name: string,
	environment: NodeJS.ProcessEnv,
	platform: string
): Promise<string | undefined> => {
	for (const entry of (environment.PATH ?? "").split(path.delimiter)) {
		const directory = entry || ".";
		const candidate = path.resolve(directory, name);
		if (await isExecutableFile(candidate, platform)) {
			return candidate;
		}
	}
	return;
};

const runCommand = async (command: string, args: string[]): Promise<void> => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let stderr = "";
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(command, args, {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		reject(
			new RipgrepDownloadError(
				`failed to start ${command}: ${getErrorMessage(error)}`
			)
		);
		return promise;
	}

	const cleanup = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	};
	const finish = (error?: Error): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		if (error) {
			reject(error);
			return;
		}
		resolve();
	};

	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = truncateUtf8(
			`${stderr}${chunk.toString("utf8")}`,
			COMMAND_OUTPUT_MAX_BYTES
		);
	});
	child.on("error", (error) => {
		finish(
			new RipgrepDownloadError(
				`failed to run ${command}: ${getErrorMessage(error)}`
			)
		);
	});
	child.on("close", (code) => {
		if (code === 0) {
			finish();
			return;
		}
		const detail = stderr.trim();
		finish(
			new RipgrepDownloadError(
				detail || `${command} exited with code ${String(code)}`
			)
		);
	});
	timer = setTimeout(() => {
		child.kill();
		finish(
			new RipgrepDownloadError(
				`${command} timed out after ${EXTRACTION_TIMEOUT_MS}ms.`
			)
		);
	}, EXTRACTION_TIMEOUT_MS);

	return promise;
};

const quotePowerShellLiteral = (value: string): string =>
	value.replaceAll("'", "''");

const extractRipgrepArchive: RipgrepArchiveExtractor = async (
	archivePath,
	extractionDirectory,
	config
): Promise<void> => {
	if (config.extension === "tar.gz") {
		await runCommand("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
		return;
	}

	const environment = process.env;
	const powershell =
		(await findExecutableOnPath("powershell.exe", environment, "win32")) ??
		(await findExecutableOnPath("pwsh.exe", environment, "win32"));
	if (!powershell) {
		throw new RipgrepDownloadError(
			"PowerShell is required to extract the ripgrep zip archive."
		);
	}

	const escapedArchive = quotePowerShellLiteral(archivePath);
	const escapedDestination = quotePowerShellLiteral(extractionDirectory);
	await runCommand(powershell, [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
	]);
};

const downloadArchive = async (
	url: string,
	archivePath: string,
	fetchImpl: RipgrepFetch
): Promise<string> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				signal: controller.signal,
				redirect: "follow",
			});
		} catch (error) {
			throw new RipgrepUnavailableError(
				`download failed: ${getErrorMessage(error)}`
			);
		}

		if (!response.ok) {
			throw new RipgrepUnavailableError(
				`download failed with HTTP ${response.status}`
			);
		}

		const contentLength = response.headers.get("content-length");
		if (
			contentLength !== null &&
			Number.isFinite(Number(contentLength)) &&
			Number(contentLength) > DOWNLOAD_MAX_BYTES
		) {
			throw new RipgrepDownloadError(
				`ripgrep archive exceeds ${DOWNLOAD_MAX_BYTES} bytes.`
			);
		}
		if (!response.body) {
			throw new RipgrepDownloadError("ripgrep download returned no body.");
		}

		const file = await open(archivePath, "wx", 0o600);
		const hash = createHash("sha256");
		let totalBytes = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				let chunkDone = false;
				let chunkValue: Uint8Array | undefined;
				try {
					const chunk = await reader.read();
					chunkDone = chunk.done;
					chunkValue = chunk.value;
				} catch (error) {
					throw new RipgrepUnavailableError(
						`download stream failed: ${getErrorMessage(error)}`
					);
				}
				if (chunkDone) {
					break;
				}
				if (!chunkValue) {
					continue;
				}
				totalBytes += chunkValue.byteLength;
				if (totalBytes > DOWNLOAD_MAX_BYTES) {
					throw new RipgrepDownloadError(
						`ripgrep archive exceeds ${DOWNLOAD_MAX_BYTES} bytes.`
					);
				}
				try {
					await file.write(chunkValue);
				} catch (error) {
					throw new RipgrepDownloadError(
						`failed to write ripgrep archive: ${getErrorMessage(error)}`
					);
				}
				hash.update(chunkValue);
			}
		} finally {
			await reader?.cancel().catch(() => undefined);
			await file.close();
		}

		if (totalBytes === 0) {
			throw new RipgrepDownloadError(
				"ripgrep download returned an empty body."
			);
		}
		return hash.digest("hex");
	} finally {
		clearTimeout(timer);
	}
};

const installStagedBinary = async (
	stagedPath: string,
	targetPath: string,
	platform: string
): Promise<void> => {
	try {
		await rename(stagedPath, targetPath);
	} catch (error) {
		if (
			(getErrorCode(error) === "EEXIST" || getErrorCode(error) === "EPERM") &&
			(await isExecutableFile(targetPath, platform))
		) {
			return;
		}
		throw new RipgrepDownloadError(
			`failed to install ripgrep: ${getErrorMessage(error)}`
		);
	}
};

export const downloadRipgrepBinary = async (
	options: RipgrepBinaryOptions = {}
): Promise<string> => {
	const platform = options.platform ?? process.platform;
	const paths = getBinaryPaths(options);
	await mkdir(paths.cacheDirectory, { recursive: true, mode: 0o700 });

	if (await isExecutableFile(paths.targetPath, platform)) {
		return paths.targetPath;
	}

	const archivePath = path.join(
		paths.cacheDirectory,
		`${paths.archiveFilename}.${randomUUID()}.partial`
	);
	const extractionDirectory = await mkdtemp(
		path.join(paths.cacheDirectory, ".extract-")
	);
	const stagedPath = path.join(
		paths.cacheDirectory,
		`${paths.executableName}.${randomUUID()}.staged`
	);

	try {
		const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${paths.archiveFilename}`;
		const actualSha256 = await downloadArchive(
			url,
			archivePath,
			options.fetchImpl ?? fetch
		);
		if (actualSha256 !== paths.config.sha256) {
			throw new RipgrepDownloadError(
				`ripgrep archive checksum mismatch: expected ${paths.config.sha256}, received ${actualSha256}.`
			);
		}

		await (options.extractArchive ?? extractRipgrepArchive)(
			archivePath,
			extractionDirectory,
			paths.config
		);

		const extractedPath = path.join(
			extractionDirectory,
			paths.archiveRoot,
			paths.executableName
		);
		if (!(await isExecutableFile(extractedPath, platform))) {
			throw new RipgrepDownloadError(
				`ripgrep archive did not contain executable: ${extractedPath}`
			);
		}

		await copyFile(extractedPath, stagedPath);
		if (platform !== "win32") {
			await chmod(stagedPath, 0o755);
		}
		await installStagedBinary(stagedPath, paths.targetPath, platform);

		if (!(await isExecutableFile(paths.targetPath, platform))) {
			throw new RipgrepDownloadError(
				`installed ripgrep executable is not runnable: ${paths.targetPath}`
			);
		}
		return paths.targetPath;
	} finally {
		await Promise.all([
			rm(archivePath, { force: true }),
			rm(stagedPath, { force: true }),
			rm(extractionDirectory, { force: true, recursive: true }),
		]);
	}
};

export const resolveRipgrepExecutable = async (
	options: RipgrepBinaryOptions = {}
): Promise<string> => {
	const environment = options.environment ?? process.env;
	const configuredExecutable = environment.WINCODE_RIPGREP_PATH;
	if (configuredExecutable) {
		return configuredExecutable;
	}
	const platform = options.platform ?? process.platform;
	const executableName = getExecutableName(platform);
	const systemExecutable = await (options.findSystemExecutable?.() ??
		findExecutableOnPath(executableName, environment, platform));
	if (systemExecutable) {
		return systemExecutable;
	}
	if (environment.WINCODE_RIPGREP_DISABLE_DOWNLOAD === "1") {
		throw new RipgrepUnavailableError("binary download is disabled");
	}

	return downloadRipgrepBinary(options);
};
