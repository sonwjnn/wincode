import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureSessionDirectoryTreeDurably,
	publishSessionFileNoReplaceDurably,
	removeSessionFileDurably,
	replaceSessionFileDurably,
} from "@/modules/sessions/storage/session-storage-durability";

const root = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-durability-")
);

const syncDirectory = async (directory: string): Promise<void> => {
	if (process.platform === "win32") {
		throw new Error("Windows must not depend on directory-handle sync.");
	}
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
};

afterAll(async () => {
	await fs.rm(root, { force: true, recursive: true });
});

test("directory setup creates every missing level with the platform durability path", async () => {
	const directory = path.join(root, "nested", "session-control", "deleted");

	await ensureSessionDirectoryTreeDurably(directory, 0o700, syncDirectory);

	expect((await fs.stat(directory)).isDirectory()).toBe(true);
});

test("no-replace publication preserves both files when a destination already exists", async () => {
	const stagingPath = path.join(root, "no-replace.staging");
	const destination = path.join(root, "no-replace.json");
	await Bun.write(stagingPath, "staged");
	await Bun.write(destination, "existing");

	await expect(
		publishSessionFileNoReplaceDurably(stagingPath, destination, syncDirectory)
	).rejects.toMatchObject({ code: "EEXIST" });
	await expect(Bun.file(stagingPath).text()).resolves.toBe("staged");
	await expect(Bun.file(destination).text()).resolves.toBe("existing");
});

test("durable file removal leaves the authoritative marker path absent", async () => {
	const markerPath = path.join(root, "removable-marker.json");
	await Bun.write(markerPath, "marker");

	await removeSessionFileDurably(markerPath, root, syncDirectory);

	expect(await Bun.file(markerPath).exists()).toBe(false);
	await expect(
		removeSessionFileDurably(markerPath, root, syncDirectory)
	).resolves.toBeUndefined();
});

test("replacement publishes the complete staged file and consumes the staging name", async () => {
	const stagingPath = path.join(root, "replace.staging");
	const destination = path.join(root, "replace.json");
	await Bun.write(stagingPath, "complete replacement");
	await Bun.write(destination, "old value");

	await replaceSessionFileDurably(stagingPath, destination, syncDirectory);

	await expect(Bun.file(destination).text()).resolves.toBe(
		"complete replacement"
	);
	expect(await Bun.file(stagingPath).exists()).toBe(false);
});
