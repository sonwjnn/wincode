import { dlopen, FFIType, read } from "bun:ffi";

export type AtomicDirectoryPublishFailureKind =
	| "destination_exists"
	| "failed"
	| "unavailable";

export class AtomicDirectoryPublishError extends Error {
	readonly kind: AtomicDirectoryPublishFailureKind;

	constructor(
		kind: AtomicDirectoryPublishFailureKind,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = "AtomicDirectoryPublishError";
		this.kind = kind;
	}
}

type AtomicDirectoryPublisher = Readonly<{
	publish: (stagingPath: string, destination: string) => void;
}>;

let cachedDarwinPublisher: AtomicDirectoryPublisher | undefined;
let cachedLinuxPublisher: AtomicDirectoryPublisher | undefined;
let cachedWindowsPublisher: AtomicDirectoryPublisher | undefined;

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

const unavailableError = (cause: unknown): AtomicDirectoryPublishError => {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new AtomicDirectoryPublishError(
		"unavailable",
		`Atomic no-replace Session bundle publication is unavailable on ${process.platform}/${process.arch}: ${reason}`,
		{ cause }
	);
};

const failedError = (
	api: string,
	nativeErrorCode: number
): AtomicDirectoryPublishError => {
	if (nativeErrorCode === 17) {
		return new AtomicDirectoryPublishError(
			"destination_exists",
			`Atomic Session bundle publication refused an existing destination (${api}, error ${nativeErrorCode}).`
		);
	}
	return new AtomicDirectoryPublishError(
		"failed",
		`Atomic Session bundle publication failed (${api}, error ${nativeErrorCode}).`
	);
};

const createDarwinPublisher = (): AtomicDirectoryPublisher => {
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
		const publisher: AtomicDirectoryPublisher = {
			publish: (stagingPath, destination) => {
				const result = library.symbols.renamex_np(
					encodeUtf8Path(stagingPath),
					encodeUtf8Path(destination),
					0x00_00_00_04
				);
				if (result !== 0) {
					const errorPointer = library.symbols.__error();
					if (errorPointer === null) {
						throw new AtomicDirectoryPublishError(
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

const createLinuxPublisher = (): AtomicDirectoryPublisher => {
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
		const publisher: AtomicDirectoryPublisher = {
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
						throw new AtomicDirectoryPublishError(
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

const createWindowsPublisher = (): AtomicDirectoryPublisher => {
	if (cachedWindowsPublisher !== undefined) {
		return cachedWindowsPublisher;
	}
	try {
		const library = dlopen("kernel32.dll", {
			GetLastError: { args: [], returns: FFIType.u32 },
			MoveFileExW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
		});
		const publisher: AtomicDirectoryPublisher = {
			publish: (stagingPath, destination) => {
				const result = library.symbols.MoveFileExW(
					encodeWindowsPath(stagingPath),
					encodeWindowsPath(destination),
					0
				);
				if (result === 0) {
					const nativeErrorCode = library.symbols.GetLastError();
					if (nativeErrorCode === 80 || nativeErrorCode === 183) {
						throw new AtomicDirectoryPublishError(
							"destination_exists",
							`Atomic Session bundle publication refused an existing destination (MoveFileExW, error ${nativeErrorCode}).`
						);
					}
					throw new AtomicDirectoryPublishError(
						"failed",
						`Atomic Session bundle publication failed (MoveFileExW, error ${nativeErrorCode}).`
					);
				}
			},
		};
		cachedWindowsPublisher = publisher;
		return publisher;
	} catch (error) {
		throw unavailableError(error);
	}
};

export const createAtomicDirectoryPublisher = (): AtomicDirectoryPublisher => {
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
		new Error("No atomic no-replace directory primitive is configured.")
	);
};
