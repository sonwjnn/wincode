import { dlopen, FFIType, read } from "bun:ffi";

export type SessionPathPublishFailureKind =
	| "destination_exists"
	| "failed"
	| "source_missing"
	| "unavailable";

export class SessionPathPublishError extends Error {
	readonly code: "EEXIST" | "ENOENT" | undefined;
	readonly kind: SessionPathPublishFailureKind;

	constructor(
		kind: SessionPathPublishFailureKind,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = "SessionPathPublishError";
		if (kind === "destination_exists") {
			this.code = "EEXIST";
		} else if (kind === "source_missing") {
			this.code = "ENOENT";
		} else {
			this.code = undefined;
		}
		this.kind = kind;
	}
}

type SessionPathPublisher = Readonly<{
	publish: (stagingPath: string, destination: string) => void;
}>;

type WindowsPathMover = Readonly<{
	move: (
		stagingPath: string,
		destination: string,
		replaceExisting: boolean
	) => void;
}>;

let cachedDarwinPublisher: SessionPathPublisher | undefined;
let cachedLinuxPublisher: SessionPathPublisher | undefined;
let cachedWindowsPublisher: SessionPathPublisher | undefined;
let cachedWindowsPathMover: WindowsPathMover | undefined;

const encodeUtf8Path = (value: string): Uint8Array => {
	const bytes = new TextEncoder().encode(value);
	const nulTerminated = new Uint8Array(bytes.byteLength + 1);
	nulTerminated.set(bytes);
	return nulTerminated;
};

const encodeWindowsPath = (value: string): Uint16Array => {
	const nulTerminated = new Uint16Array(value.length + 1);
	for (let index = 0; index < value.length; index += 1) {
		nulTerminated[index] = value.charCodeAt(index);
	}
	return nulTerminated;
};

const unavailableError = (cause: unknown): SessionPathPublishError => {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new SessionPathPublishError(
		"unavailable",
		`Atomic Session path publication is unavailable on ${process.platform}/${process.arch}: ${reason}`,
		{ cause }
	);
};

const failedError = (
	api: string,
	nativeErrorCode: number
): SessionPathPublishError => {
	if (nativeErrorCode === 17) {
		return new SessionPathPublishError(
			"destination_exists",
			`Atomic Session path publication refused an existing destination (${api}, error ${nativeErrorCode}).`
		);
	}
	if (nativeErrorCode === 2) {
		return new SessionPathPublishError(
			"source_missing",
			`Session path publication source does not exist (${api}, error ${nativeErrorCode}).`
		);
	}
	return new SessionPathPublishError(
		"failed",
		`Atomic Session path publication failed (${api}, error ${nativeErrorCode}).`
	);
};

const createDarwinPublisher = (): SessionPathPublisher => {
	if (cachedDarwinPublisher !== undefined) {
		return cachedDarwinPublisher;
	}
	try {
		const library = dlopen("/usr/lib/libSystem.B.dylib", {
			__error: { args: [], returns: FFIType.ptr },
			renamex_np: {
				args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
				returns: FFIType.i32,
			},
		});
		const publisher: SessionPathPublisher = {
			publish: (stagingPath, destination) => {
				const result = library.symbols.renamex_np(
					encodeUtf8Path(stagingPath),
					encodeUtf8Path(destination),
					0x00_00_00_04
				);
				if (result !== 0) {
					const errorPointer = library.symbols.__error();
					if (errorPointer === null) {
						throw new SessionPathPublishError(
							"failed",
							"renamex_np failed without an available native error code."
						);
					}
					throw failedError("renamex_np", read.i32(errorPointer));
				}
			},
		};
		cachedDarwinPublisher = publisher;
		return publisher;
	} catch (error) {
		throw unavailableError(error);
	}
};

const createLinuxPublisher = (): SessionPathPublisher => {
	if (cachedLinuxPublisher !== undefined) {
		return cachedLinuxPublisher;
	}
	try {
		const library = dlopen("libc.so.6", {
			__errno_location: { args: [], returns: FFIType.ptr },
			renameat2: {
				args: [
					FFIType.i32,
					FFIType.cstring,
					FFIType.i32,
					FFIType.cstring,
					FFIType.u32,
				],
				returns: FFIType.i32,
			},
		});
		const publisher: SessionPathPublisher = {
			publish: (stagingPath, destination) => {
				const result = library.symbols.renameat2(
					-100,
					encodeUtf8Path(stagingPath),
					-100,
					encodeUtf8Path(destination),
					1
				);
				if (result !== 0) {
					const errorPointer = library.symbols.__errno_location();
					if (errorPointer === null) {
						throw new SessionPathPublishError(
							"failed",
							"renameat2 failed without an available native error code."
						);
					}
					throw failedError("renameat2", read.i32(errorPointer));
				}
			},
		};
		cachedLinuxPublisher = publisher;
		return publisher;
	} catch (error) {
		throw unavailableError(error);
	}
};

const WINDOWS_MOVE_ATTEMPTS = 5;
const isTransientWindowsMoveError = (nativeErrorCode: number): boolean =>
	// A failing MoveFileExW performs no move, so a bounded retry is safe when a
	// scanner or another handle briefly denies the namespace update.
	nativeErrorCode === 5 || nativeErrorCode === 32 || nativeErrorCode === 33;

const createWindowsPathMover = (): WindowsPathMover => {
	if (cachedWindowsPathMover !== undefined) {
		return cachedWindowsPathMover;
	}
	try {
		const library = dlopen("kernel32.dll", {
			GetLastError: { args: [], returns: FFIType.u32 },
			MoveFileExW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
		});
		const mover: WindowsPathMover = {
			move: (stagingPath, destination, replaceExisting) => {
				// biome-ignore lint/suspicious/noBitwiseOperators: Win32 flags are bit masks.
				const flags = 0x8 | (replaceExisting ? 0x1 : 0);
				let result = 0;
				let nativeErrorCode = 0;
				for (let attempt = 0; attempt < WINDOWS_MOVE_ATTEMPTS; attempt++) {
					result = library.symbols.MoveFileExW(
						encodeWindowsPath(stagingPath),
						encodeWindowsPath(destination),
						flags
					);
					if (result !== 0) {
						return;
					}
					nativeErrorCode = library.symbols.GetLastError();
					if (!isTransientWindowsMoveError(nativeErrorCode)) {
						break;
					}
					Bun.sleepSync(10 * 2 ** attempt);
				}
				if (nativeErrorCode === 80 || nativeErrorCode === 183) {
					throw new SessionPathPublishError(
						"destination_exists",
						`Atomic Session path publication refused an existing destination (MoveFileExW, error ${nativeErrorCode}).`
					);
				}
				if (nativeErrorCode === 2 || nativeErrorCode === 3) {
					throw new SessionPathPublishError(
						"source_missing",
						`Session path publication source does not exist (MoveFileExW, error ${nativeErrorCode}).`
					);
				}
				throw new SessionPathPublishError(
					"failed",
					`Durable Session path move failed (MoveFileExW, error ${nativeErrorCode}).`
				);
			},
		};
		cachedWindowsPathMover = mover;
		return mover;
	} catch (error) {
		throw unavailableError(error);
	}
};

const createWindowsPublisher = (): SessionPathPublisher => {
	if (cachedWindowsPublisher !== undefined) {
		return cachedWindowsPublisher;
	}
	const mover = createWindowsPathMover();
	const publisher: SessionPathPublisher = {
		publish: (stagingPath, destination) =>
			mover.move(stagingPath, destination, false),
	};
	cachedWindowsPublisher = publisher;
	return publisher;
};

/** Uses the documented MOVEFILE_WRITE_THROUGH flag for Windows path publication. */
export const moveWindowsPathDurably = (
	stagingPath: string,
	destination: string,
	replaceExisting = false
): void => {
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw unavailableError(
			new Error(
				"The Windows durable path mover is available only on Windows x64."
			)
		);
	}
	createWindowsPathMover().move(stagingPath, destination, replaceExisting);
};

export const createAtomicPathPublisher = (): SessionPathPublisher => {
	if (
		process.platform === "darwin" &&
		(process.arch === "arm64" || process.arch === "x64")
	) {
		return createDarwinPublisher();
	}
	if (
		process.platform === "linux" &&
		(process.arch === "arm64" || process.arch === "x64")
	) {
		return createLinuxPublisher();
	}
	if (process.platform === "win32" && process.arch === "x64") {
		return createWindowsPublisher();
	}
	throw unavailableError(
		new Error("No atomic no-replace Session path primitive is configured.")
	);
};
