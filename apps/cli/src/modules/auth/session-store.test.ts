import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type StoredSession } from "./session-store";

const temporaryPaths: string[] = [];

afterEach(async () => {
	for (const path of temporaryPaths.splice(0)) {
		await rm(path, { force: true, recursive: true });
	}
});

const createSession = (): StoredSession => ({
	accessToken: "access-token",
	clientId: "wincode-cli",
	expiresAt: "2026-07-11T12:00:00.000Z",
	issuer: "https://auth.example.com",
	refreshToken: "refresh-token",
	scope: "openid offline_access",
	tokenType: "Bearer",
	updatedAt: "2026-07-11T11:00:00.000Z",
});

describe("SessionStore", () => {
	test("atomically saves an owner-only session file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-auth-"));
		temporaryPaths.push(directory);
		const sessionPath = join(directory, "auth", "auth.json");
		const session = createSession();

		await new SessionStore(sessionPath).save(session);

		expect(JSON.parse(await readFile(sessionPath, "utf8"))).toEqual(session);
		expect(
			(await stat(join(directory, "auth"))).mode.toString(8).slice(-3)
		).toBe("700");
		expect((await stat(sessionPath)).mode.toString(8).slice(-3)).toBe("600");
	});

	test("loads and clears a saved session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-auth-"));
		temporaryPaths.push(directory);
		const sessionPath = join(directory, "auth", "auth.json");
		const store = new SessionStore(sessionPath);
		const session = createSession();

		await store.save(session);
		expect(await store.load()).toEqual(session);

		await store.clear();
		expect(await store.load()).toBeNull();
	});

	test("refuses to replace a non-regular file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-auth-"));
		temporaryPaths.push(directory);
		const sessionDirectory = join(directory, "auth");
		await mkdir(sessionDirectory);

		await expect(
			new SessionStore(sessionDirectory).save(createSession())
		).rejects.toThrow("Refusing to replace non-regular session file");
	});
});
