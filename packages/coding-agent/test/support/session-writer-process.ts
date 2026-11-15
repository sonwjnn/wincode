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

export type SessionWriterPeerResult = Readonly<{
	code?: string;
	kind:
		| "append-error"
		| "append-result"
		| "delete-error"
		| "delete-result"
		| "read-error"
		| "read-result"
		| "unknown-command";
	outcome?: unknown;
	recordCount?: number;
	title?: string;
}>;

export type SessionWriterContenderProcess = Readonly<{
	pid: number;
	request: (command: string) => Promise<SessionWriterPeerResult>;
	result: Promise<SessionWriterContenderResult>;
	release: () => Promise<void>;
	stop: () => Promise<void>;
}>;

const createLineReader = (
	stream: ReadableStream<Uint8Array>
): Readonly<{
	close: () => void;
	next: () => Promise<string>;
}> => {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	return {
		close: () => {
			reader.releaseLock();
		},
		next: async () => {
			for (;;) {
				const newline = text.indexOf("\n");
				if (newline >= 0) {
					const line = text.slice(0, newline);
					text = text.slice(newline + 1);
					return line;
				}
				const { done, value } = await reader.read();
				if (done) {
					throw new Error("The writer contender exited before reporting.");
				}
				text += decoder.decode(value, { stream: true });
			}
		},
	};
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
	const lines = createLineReader(
		contender.stdout as ReadableStream<Uint8Array>
	);
	const result = lines
		.next()
		.then((line) => JSON.parse(line) as SessionWriterContenderResult);
	let released = false;
	return {
		pid: contender.pid,
		result,
		request: async (command) => {
			contender.stdin.write(`${command}\n`);
			return JSON.parse(await lines.next()) as SessionWriterPeerResult;
		},
		release: async () => {
			if (released) {
				return;
			}
			released = true;
			contender.stdin.write("release\n");
			contender.stdin.end();
			const exitCode = await contender.exited;
			lines.close();
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
			lines.close();
		},
	};
};
