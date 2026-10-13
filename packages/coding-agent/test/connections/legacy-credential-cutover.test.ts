import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	LegacyCredentialCleanupEntry,
	LegacyCredentialCleanupStore,
} from "@wincode/ai/connections/legacy-cleanup";
import { connectionProviderIds } from "@wincode/ai/models";
import {
	createLegacyCredentialCutoverGate,
	LegacyCredentialCutoverBlockedError,
} from "@/modules/connections/legacy-credential-cutover";

const markerPathFor = (userDataDir: string): string =>
	path.join(
		userDataDir,
		"connection-migrations",
		"connections-v2-cleanup.json"
	);

const verifiedEntry = (
	providerId: (typeof connectionProviderIds)[number]
): LegacyCredentialCleanupEntry => ({
	providerId,
	platform: "not-configured",
	file: "absent",
});

const verifiedReport = (): readonly LegacyCredentialCleanupEntry[] =>
	connectionProviderIds.map(verifiedEntry);

const gateFor = (
	userDataDir: string,
	cleanupStore: LegacyCredentialCleanupStore
) => createLegacyCredentialCutoverGate({ cleanupStore, userDataDir });

const fileExists = async (filePath: string): Promise<boolean> =>
	fs.lstat(filePath).then(
		() => true,
		() => false
	);

test("an incomplete cleanup blocks model execution and does not write the completion marker", async () => {
	const userDataDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-credential-cutover-blocked-")
	);
	let requestStarted = false;
	const report = connectionProviderIds.map((providerId) =>
		providerId === "google"
			? ({ providerId, platform: "unverified", file: "deleted" } as const)
			: verifiedEntry(providerId)
	);
	const cleanupStore: LegacyCredentialCleanupStore = {
		removeAllAndVerify: async () => report,
	};
	try {
		const gate = gateFor(userDataDir, cleanupStore);
		const error = await gate
			.run(async () => {
				requestStarted = true;
				return "sent";
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(LegacyCredentialCutoverBlockedError);
		if (error instanceof LegacyCredentialCutoverBlockedError) {
			expect(error.reason).toBe("cleanup-incomplete");
			expect(error.report).toEqual(report);
		}
		expect(requestStarted).toBe(false);
		expect(await fileExists(markerPathFor(userDataDir))).toBe(false);
	} finally {
		await fs.rm(userDataDir, { force: true, recursive: true });
	}
});

test("cleanup failures hide secret text and block model execution", async () => {
	const userDataDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-credential-cutover-secret-error-")
	);
	const fakeSecret = "fake-credential-must-not-leak";
	let requestStarted = false;
	try {
		const gate = gateFor(userDataDir, {
			removeAllAndVerify: async () => {
				throw new Error(fakeSecret);
			},
		});
		const error = await gate
			.run(async () => {
				requestStarted = true;
				return "sent";
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(LegacyCredentialCutoverBlockedError);
		if (error instanceof LegacyCredentialCutoverBlockedError) {
			expect(error.reason).toBe("cleanup-failed");
			expect(error.message).not.toContain(fakeSecret);
			expect(JSON.stringify(error.report)).not.toContain(fakeSecret);
		}
		expect(requestStarted).toBe(false);
		expect(await fileExists(markerPathFor(userDataDir))).toBe(false);
	} finally {
		await fs.rm(userDataDir, { force: true, recursive: true });
	}
});

test("a verified cleanup writes a durable marker and survives gate recreation", async () => {
	const userDataDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-credential-cutover-complete-")
	);
	let cleanupCalls = 0;
	const cleanupStore: LegacyCredentialCleanupStore = {
		removeAllAndVerify: async () => {
			cleanupCalls++;
			return verifiedReport();
		},
	};
	try {
		const firstGate = gateFor(userDataDir, cleanupStore);
		expect(await firstGate.run(async () => "first turn")).toBe("first turn");
		expect(await fileExists(markerPathFor(userDataDir))).toBe(true);
		expect(cleanupCalls).toBe(1);

		const restartedGate = gateFor(userDataDir, {
			removeAllAndVerify: async () => {
				throw new Error("verified marker should avoid repeating cleanup");
			},
		});
		expect(await restartedGate.run(async () => "restarted turn")).toBe(
			"restarted turn"
		);
		expect(cleanupCalls).toBe(1);
	} finally {
		await fs.rm(userDataDir, { force: true, recursive: true });
	}
});

test("a partial cleanup can be retried after restart without claiming rollback", async () => {
	const userDataDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-credential-cutover-retry-")
	);
	const remaining = new Set(["openai", "google"]);
	let firstRequestStarted = false;
	const firstCleanup: LegacyCredentialCleanupStore = {
		removeAllAndVerify: async () => {
			remaining.delete("openai");
			return connectionProviderIds.map((providerId) =>
				providerId === "google"
					? ({ providerId, platform: "unverified", file: "deleted" } as const)
					: verifiedEntry(providerId)
			);
		},
	};
	try {
		const firstGate = gateFor(userDataDir, firstCleanup);
		const firstError = await firstGate
			.run(async () => {
				firstRequestStarted = true;
				return "sent";
			})
			.catch((reason: unknown) => reason);

		expect(firstError).toBeInstanceOf(LegacyCredentialCutoverBlockedError);
		expect(firstRequestStarted).toBe(false);
		expect(remaining.has("openai")).toBe(false);
		expect(remaining.has("google")).toBe(true);
		expect(await fileExists(markerPathFor(userDataDir))).toBe(false);

		const retryCleanup: LegacyCredentialCleanupStore = {
			removeAllAndVerify: async () => {
				remaining.clear();
				return verifiedReport();
			},
		};
		const restartedGate = gateFor(userDataDir, retryCleanup);
		expect(await restartedGate.run(async () => "retried turn")).toBe(
			"retried turn"
		);
		expect(remaining.size).toBe(0);
		expect(await fileExists(markerPathFor(userDataDir))).toBe(true);
	} finally {
		await fs.rm(userDataDir, { force: true, recursive: true });
	}
});

test("a cleanup report missing a known provider fails closed", async () => {
	const userDataDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-credential-cutover-invalid-report-")
	);
	let requestStarted = false;
	try {
		const gate = gateFor(userDataDir, {
			removeAllAndVerify: async () => [verifiedEntry("openai")],
		});
		await expect(
			gate.run(async () => {
				requestStarted = true;
			})
		).rejects.toBeInstanceOf(LegacyCredentialCutoverBlockedError);
		expect(requestStarted).toBe(false);
		expect(await fileExists(markerPathFor(userDataDir))).toBe(false);
	} finally {
		await fs.rm(userDataDir, { force: true, recursive: true });
	}
});
