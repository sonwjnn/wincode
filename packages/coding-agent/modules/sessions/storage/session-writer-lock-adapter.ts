export type SessionWriterLockAdapterHandle = Readonly<{
	truncate: (length: number) => Promise<void>;
	writeFile: (content: string) => Promise<void>;
	release: () => Promise<void>;
}>;

export type SessionWriterLockAdapter = Readonly<{
	primitive: "flock" | "LockFileEx";
	acquire: (
		lockPath: string
	) => Promise<SessionWriterLockAdapterHandle | undefined>;
}>;
