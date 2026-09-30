import { fileURLToPath } from "node:url";

export type SessionWriterContenderResult =
	| Readonly<{ kind: "acquired" }>
	| Readonly<{ code: string; kind: "rejected" }>;

export type SessionWriterContenderOptions = Readonly<{
	attachmentRoot: string;
	databasePath: string;
	userDataDirectory?: string;
	sessionId: string;
	snapshotRoot: string;
	workspaceRoot: string;
}>;

export type SessionWriterContenderProcess = Readonly<{
	pid: number;
	result: Promise<SessionWriterContenderResult>;
	release: () => Promise<void>;
	stop: () => Promise<void>;
}>;

const readLine = async (
	stream: ReadableStream<Uint8Array>
): Promise<string> => {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				throw new Error("The writer contender exited before reporting.");
			}
			text += decoder.decode(value, { stream: true });
			const newline = text.indexOf("\n");
			if (newline >= 0) {
				return text.slice(0, newline);
			}
		}
	} finally {
		reader.releaseLock();
	}
};

export const startSessionWriterContender = (
	options: SessionWriterContenderOptions
): SessionWriterContenderProcess => {
	const { userDataDirectory, ...contenderOptions } = options;
	const contender = Bun.spawn(
		[
			process.execPath,
			"run",
			fileURLToPath(new URL("./session-writer-contender.ts", import.meta.url)),
			JSON.stringify(contenderOptions),
		],
		{
			env: {
				...process.env,
				...(userDataDirectory === undefined
					? {}
					: {
							APPDATA: userDataDirectory,
							HOME: userDataDirectory,
							XDG_DATA_HOME: userDataDirectory,
						}),
			},
			stderr: "ignore",
			stdin: "pipe",
			stdout: "pipe",
		}
	);
	const result = readLine(contender.stdout).then(
		(line) => JSON.parse(line) as SessionWriterContenderResult
	);
	let released = false;
	return {
		pid: contender.pid,
		result,
		release: async () => {
			if (released) {
				return;
			}
			released = true;
			contender.stdin.write("release\n");
			contender.stdin.end();
			const exitCode = await contender.exited;
			if (exitCode !== 0) {
				throw new Error(`The writer contender exited with code ${exitCode}.`);
			}
		},
		stop: async () => {
			try {
				contender.kill();
			} catch {
				// The contender may already have exited after refusing ownership.
			}
			await contender.exited;
		},
	};
};
