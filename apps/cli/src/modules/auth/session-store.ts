import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const sessionSchema = z.object({
	accessToken: z.string().min(1),
	clientId: z.string().min(1),
	expiresAt: z.string().datetime(),
	issuer: z.url(),
	refreshToken: z.string().min(1),
	scope: z.string(),
	tokenType: z.literal("Bearer"),
	updatedAt: z.string().datetime(),
});

export type StoredSession = z.infer<typeof sessionSchema>;

export const DEFAULT_SESSION_PATH = join(homedir(), ".wincode", "auth.json");

export class SessionStore {
	private readonly path: string;

	constructor(path = DEFAULT_SESSION_PATH) {
		this.path = path;
	}

	async save(session: StoredSession): Promise<void> {
		const validatedSession = sessionSchema.parse(session);
		const directory = dirname(this.path);
		await mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
		await chmod(directory, DIRECTORY_MODE);
		await rejectNonRegularFile(this.path);

		const temporaryPath = `${this.path}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(
				temporaryPath,
				JSON.stringify(validatedSession, null, 2),
				{
					encoding: "utf8",
					mode: FILE_MODE,
					flag: "wx",
				}
			);
			await chmod(temporaryPath, FILE_MODE);
			await rename(temporaryPath, this.path);
			await chmod(this.path, FILE_MODE);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	}

	async load(): Promise<StoredSession | null> {
		try {
			await rejectNonRegularFile(this.path);
			return sessionSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
		} catch (error) {
			if (isMissingFileError(error)) {
				return null;
			}
			throw error;
		}
	}

	async clear(): Promise<void> {
		await rejectNonRegularFile(this.path);
		await rm(this.path, { force: true });
	}
}

async function rejectNonRegularFile(path: string): Promise<void> {
	try {
		const stats = await lstat(path);
		if (!stats.isFile()) {
			throw new Error(`Refusing to replace non-regular session file: ${path}`);
		}
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
