import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type SessionMessageId,
	type SessionRecordId,
	type SubmissionId,
	toSubmissionId,
} from "@wincode/agent-core";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { createSessionUserMessage } from "@/modules/sessions/message";
import {
	createDatabase,
	type SessionDatabase,
} from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveSessionLogFilePath,
} from "@/modules/sessions/storage/path";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	encodeSessionLogLine,
} from "@/modules/sessions/storage/session-jsonl-codec";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	sessionId,
	sessionMessageId,
} from "../test/support/identifiers";

const sessionCount = Number(process.env.BENCH_SESSIONS ?? "10000");
const checkpointCount = Number(process.env.BENCH_CHECKPOINTS ?? "100000");
if (!(Number.isSafeInteger(sessionCount) && sessionCount >= 201)) {
	throw new Error("BENCH_SESSIONS must be an integer of at least 201.");
}
if (!(Number.isSafeInteger(checkpointCount) && checkpointCount >= 500)) {
	throw new Error("BENCH_CHECKPOINTS must be an integer of at least 500.");
}

const root = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-jsonl-bench-")
);
process.env.WINCODE_TEST_SESSION_INDEX_DIR = path.join(root, "path-index");
const workspaceRoot = path.join(root, "workspace");
const attachmentRoot = path.join(root, "attachments");
const databasePath = path.join(root, "sessions.sqlite");
const logRoot = resolveLocalSessionLogRoot(databasePath);
const measuredAt = new Date().toISOString();
const fixedDate = new Date("2026-10-31T00:00:00.000Z");
const fixedTimestamp = fixedDate.toISOString();
const benchmarkAgentId = agentId("session-jsonl-benchmark-agent");

const rss = (): number => process.memoryUsage().rss;
type Measurement<Value> = Readonly<{
	durationMs: number;
	peakRssBytes: number;
	value: Value;
}>;

type DiscoveryValue = Readonly<{ issueCount: number; sessionCount: number }>;

const measure = async <Value>(
	operation: () => Promise<Value>
): Promise<Measurement<Value>> => {
	const startingRss = rss();
	let peakRssBytes = startingRss;
	let sampling = true;
	const sampler = (async () => {
		while (sampling) {
			peakRssBytes = Math.max(peakRssBytes, rss());
			await Bun.sleep(50);
		}
	})();
	const startedAt = performance.now();
	try {
		const value = await operation();
		return {
			durationMs: performance.now() - startedAt,
			peakRssBytes,
			value,
		};
	} finally {
		sampling = false;
		await sampler;
	}
};

type LatencySummary = Readonly<{
	count: number;
	maxMs: number;
	medianMs: number;
	p95Ms: number;
	minMs: number;
}>;

const summarizeSamples = (samples: readonly number[]): LatencySummary => {
	const sorted = [...samples].sort((left, right) => left - right);
	const quantile = (fraction: number): number =>
		sorted[
			Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
		] ?? 0;
	return {
		count: samples.length,
		maxMs: sorted.at(-1) ?? 0,
		medianMs: quantile(0.5),
		p95Ms: quantile(0.95),
		minMs: sorted[0] ?? 0,
	};
};

const sampleLatency = async (
	count: number,
	operation: () => Promise<unknown>
): Promise<
	Readonly<{
		afterRssBytes: number;
		beforeRssBytes: number;
		latency: LatencySummary;
	}>
> => {
	const beforeRssBytes = rss();
	const samples: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const startedAt = performance.now();
		await operation();
		samples.push(performance.now() - startedAt);
	}
	return {
		afterRssBytes: rss(),
		beforeRssBytes,
		latency: summarizeSamples(samples),
	};
};

const openStore = (
	projectionPath: string,
	operationalDatabase: SessionDatabase,
	options: Readonly<{ fileIo?: SessionLogFileIo }> = {}
) => {
	const database = createDatabase(projectionPath);
	const projectionStore = createDrizzleSessionStore(database.db, {
		attachmentRoot,
		operationalDatabase,
		sessionLogRoot: logRoot,
		workspaceRoot,
	});
	const store = createSessionJsonlStore(
		projectionStore,
		logRoot,
		options.fileIo
	);
	return { database, projectionStore, store };
};

const writeSessionFixture = async (
	id: SessionId,
	index: number
): Promise<void> => {
	const header = createSessionLogHeader(
		id,
		`bench-log-${index}`,
		fixedTimestamp
	);
	const created = createSessionLogEvent({
		operationId: `bench-created-${index}`,
		payload: {
			createdAt: fixedTimestamp,
			editMode: "hashline",
			lastMessageAt: null,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			pinned: false,
			title: "Untitled Session",
		},
		previousHash: header.entryHash,
		sequence: 1,
		sessionId: id,
		timestamp: fixedTimestamp,
		type: "session.created",
	});
	const headerLine = encodeSessionLogLine(header);
	const createdLine = encodeSessionLogLine(created);
	const bytes = new Uint8Array(headerLine.byteLength + createdLine.byteLength);
	bytes.set(headerLine);
	bytes.set(createdLine, headerLine.byteLength);
	await Bun.write(resolveSessionLogFilePath(logRoot, id), bytes);
};

const writeFully = async (
	handle: fs.FileHandle,
	bytes: Uint8Array
): Promise<void> => {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await handle.write(
			bytes,
			offset,
			bytes.byteLength - offset,
			null
		);
		if (result.bytesWritten <= 0) {
			throw new Error("Benchmark log writer made no progress.");
		}
		offset += result.bytesWritten;
	}
};

const appendCheckpointRecords = async (
	filePath: string,
	id: SessionId,
	count: number
): Promise<
	Readonly<{
		recordIds: SessionRecordId[];
		submissions: Map<
			number,
			Readonly<{
				messageId: SessionMessageId;
				recordId: SessionRecordId;
				submissionId: SubmissionId;
			}>
		>;
	}>
> => {
	const existing = decodeSessionLog(id, await Bun.file(filePath).bytes());
	let sequence = existing.nextSequence;
	let previousHash = existing.lastHash;
	let batchBytes = 0;
	let batchLines: Uint8Array[] = [];
	const recordIds: SessionRecordId[] = [];
	const submissions = new Map<
		number,
		Readonly<{
			messageId: SessionMessageId;
			recordId: SessionRecordId;
			submissionId: SubmissionId;
		}>
	>();
	const submissionIndexes = new Set([count - 51, count - 201]);
	const handle = await fs.open(filePath, "a");
	const flushBatch = async (): Promise<void> => {
		if (batchLines.length === 0) {
			return;
		}
		const bytes = new Uint8Array(batchBytes);
		let offset = 0;
		for (const line of batchLines) {
			bytes.set(line, offset);
			offset += line.byteLength;
		}
		await writeFully(handle, bytes);
		batchBytes = 0;
		batchLines = [];
	};
	try {
		for (let index = 0; index < count; index += 1) {
			const messageId = sessionMessageId(`bench-message-${index}`);
			const submissionId = submissionIndexes.has(index)
				? toSubmissionId(`bench-submission-${index}`)
				: undefined;
			const message = createSessionUserMessage(
				`checkpoint-${index}`,
				submissionId === undefined
					? undefined
					: {
							agent: benchmarkAgentId,
							model: DEFAULT_PROVIDER_MODEL_SELECTION,
							submissionId,
							submissionStatus: "pending",
						},
				[],
				[],
				messageId
			);
			const record = buildUserSessionRecord({
				agentId: benchmarkAgentId,
				message,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(`bench-turn-${index}`),
			});
			const envelope = createSessionLogEvent({
				operationId: `bench-record-${index}`,
				payload: { record },
				previousHash,
				sequence,
				sessionId: id,
				timestamp: fixedTimestamp,
				type: "record.committed",
			});
			previousHash = envelope.entryHash;
			sequence += 1;
			const line = encodeSessionLogLine(envelope);
			batchLines.push(line);
			batchBytes += line.byteLength;
			recordIds.push(record.id);
			if (submissionId !== undefined) {
				submissions.set(index, {
					messageId,
					recordId: record.id,
					submissionId,
				});
			}
			if (batchLines.length >= 1000) {
				await flushBatch();
			}
			if ((index + 1) % 10_000 === 0) {
				console.log(`fixture checkpoints: ${index + 1}/${count}`);
			}
		}
		await flushBatch();
		await handle.sync();
	} finally {
		await handle.close();
	}
	return { recordIds, submissions };
};

const appendOneRecord = async (
	filePath: string,
	id: SessionId,
	index: number
): Promise<string> => {
	const current = decodeSessionLog(id, await Bun.file(filePath).bytes());
	const message = createSessionUserMessage(
		`checkpoint-${index}`,
		undefined,
		[],
		[],
		sessionMessageId(`bench-message-${index}`)
	);
	const record = buildUserSessionRecord({
		agentId: benchmarkAgentId,
		message,
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId(`bench-turn-${index}`),
	});
	const event = createSessionLogEvent({
		operationId: `bench-record-${index}`,
		payload: { record },
		previousHash: current.lastHash,
		sequence: current.nextSequence,
		sessionId: id,
		timestamp: fixedTimestamp,
		type: "record.committed",
	});
	const handle = await fs.open(filePath, "a");
	try {
		await writeFully(handle, encodeSessionLogLine(event));
		await handle.sync();
	} finally {
		await handle.close();
	}
	return record.id;
};

const percentage = (value: number): number => Math.round(value * 100) / 100;
const databaseConnections: Array<{ close: () => void }> = [];
try {
	await fs.mkdir(workspaceRoot, { recursive: true });
	const operational = createDatabase(databasePath);
	databaseConnections.push({ close: () => operational.sqlite.close() });
	const fixtureProjectionDatabase = createDatabase(
		path.join(root, "fixture-projection.sqlite")
	);
	databaseConnections.push({
		close: () => fixtureProjectionDatabase.sqlite.close(),
	});
	const fixtureProjectionStore = createDrizzleSessionStore(
		fixtureProjectionDatabase.db,
		{
			attachmentRoot,
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot,
		}
	);
	const ids = Array.from({ length: sessionCount }, (_, index) =>
		sessionId(`bench-session-${String(index).padStart(5, "0")}`)
	);
	const sessionSeed = await measure(async () => {
		for (let index = 0; index < ids.length; index += 1) {
			const id = ids[index];
			if (id === undefined) {
				throw new Error(`Fixture Session ${index} is missing.`);
			}
			await writeSessionFixture(id, index);
			if ((index + 1) % 1000 === 0) {
				console.log(`fixture Sessions: ${index + 1}/${ids.length}`);
			}
		}
		const workspaceId = fixtureProjectionStore.jsonlProjection.workspaceId;
		const insertBinding = operational.sqlite.prepare(
			"INSERT INTO local_session_binding (session_id, workspace_id) VALUES (?, ?)"
		);
		const bindAll = operational.sqlite.transaction(() => {
			for (const id of ids) {
				insertBinding.run(id, workspaceId);
			}
		});
		bindAll();
		return ids.length;
	});
	console.log(
		`fixture Session logs complete: ${percentage(sessionSeed.durationMs)}ms`
	);
	const checkpointSessionId = ids[0];
	if (checkpointSessionId === undefined) {
		throw new Error("The benchmark has no Session IDs.");
	}
	const checkpointPath = resolveSessionLogFilePath(
		logRoot,
		checkpointSessionId
	);
	const checkpointSeed = await measure(
		async () =>
			await appendCheckpointRecords(
				checkpointPath,
				checkpointSessionId,
				checkpointCount
			)
	);

	console.log(
		`fixture checkpoint log complete: ${percentage(checkpointSeed.durationMs)}ms`
	);
	let discovery: Measurement<DiscoveryValue> | undefined;
	if (process.env.BENCH_SKIP_DISCOVERY === "1") {
		console.log("cold discovery skipped by BENCH_SKIP_DISCOVERY=1");
	} else {
		const coldDiscovery = openStore(
			path.join(root, "cold-discovery.sqlite"),
			operational.db
		);
		databaseConnections.push({
			close: () => coldDiscovery.database.sqlite.close(),
		});
		discovery = await measure(async () => {
			const catalog = await coldDiscovery.store.listSessionCatalog();
			if (
				catalog.sessions.length !== sessionCount ||
				catalog.issues.length !== 0
			) {
				throw new Error(
					`Cold discovery returned ${catalog.sessions.length} Sessions and ${catalog.issues.length} issues.`
				);
			}
			return {
				issueCount: catalog.issues.length,
				sessionCount: catalog.sessions.length,
			};
		});
		console.log(
			`cold discovery complete: ${percentage(discovery.durationMs)}ms peakRss=${discovery.peakRssBytes}`
		);
	}
	const rebuild = openStore(
		path.join(root, "cold-rebuild.sqlite"),
		operational.db
	);
	databaseConnections.push({ close: () => rebuild.database.sqlite.close() });
	const coldRebuild = await measure(async () => {
		const result = await rebuild.store.rebuildProjection(
			{ kind: "all" },
			async (operation) => await operation()
		);
		if (result.issues.length !== 0) {
			throw new Error(`Cold rebuild reported ${result.issues.length} issues.`);
		}
		return {
			issueCount: result.issues.length,
			rebuiltSessionCount: result.rebuiltSessionIds.length,
		};
	});

	console.log(`cold rebuild complete: ${percentage(coldRebuild.durationMs)}ms`);
	const catalogPage50 = await rebuild.store.listSessionsPage({ limit: 50 });
	const catalogPage200 = await rebuild.store.listSessionsPage({ limit: 200 });
	const expectedSessionOrder = ids;
	if (
		catalogPage200.sessions.map(({ id }) => id).join("\0") !==
		expectedSessionOrder.slice(0, 200).join("\0")
	) {
		throw new Error("Same-timestamp Session catalog order was not stable.");
	}
	if (
		catalogPage50.nextCursor === undefined ||
		catalogPage200.nextCursor === undefined
	) {
		throw new Error("The catalog benchmark did not return pagination cursors.");
	}
	const catalogTargetId = ids[200];
	if (catalogTargetId === undefined) {
		throw new Error("The catalog status-revision target is absent.");
	}
	await rebuild.store.updateSession(catalogTargetId, {
		pinned: true,
		title: "changed after cursor capture",
	});
	const catalogSnapshotPage = await rebuild.store.listSessionsPage({
		cursor: catalogPage200.nextCursor,
		limit: 200,
	});
	const catalogSnapshotTarget = catalogSnapshotPage.sessions.find(
		({ id }) => id === catalogTargetId
	);
	if (
		catalogSnapshotTarget?.pinned !== false ||
		catalogSnapshotTarget.title !== "Untitled Session"
	) {
		throw new Error(
			"A catalog cursor observed a post-snapshot status revision."
		);
	}

	const historyBoundaryChecks: Readonly<{
		limit: number;
		passed: boolean;
	}>[] = [];
	for (const limit of [50, 200]) {
		const firstPage = await rebuild.store.readSessionHistoryPage(
			checkpointSessionId,
			{ limit }
		);
		if (firstPage.nextCursor === undefined) {
			throw new Error(`History page limit ${limit} did not return a cursor.`);
		}
		const expectedIds = checkpointSeed.value.recordIds.slice(-limit);
		if (
			firstPage.records.map(({ id }) => id).join("\0") !==
			expectedIds.join("\0")
		) {
			throw new Error(
				`Same-timestamp checkpoint order failed at limit ${limit}.`
			);
		}
		const boundaryIndex = checkpointCount - limit - 1;
		const boundarySubmission =
			checkpointSeed.value.submissions.get(boundaryIndex);
		if (boundarySubmission === undefined) {
			throw new Error(`Missing status fixture at boundary ${boundaryIndex}.`);
		}
		await rebuild.store.updateSessionSubmission({
			messageId: boundarySubmission.messageId,
			recordId: boundarySubmission.recordId,
			sessionId: checkpointSessionId,
			status: "processing",
			submissionId: boundarySubmission.submissionId,
		});
		const nextPage = await rebuild.store.readSessionHistoryPage(
			checkpointSessionId,
			{ cursor: firstPage.nextCursor, limit }
		);
		const boundaryRecord = nextPage.records.find(
			({ id }) => id === boundarySubmission.recordId
		);
		const status = boundaryRecord?.messages[0]?.metadata?.submissionStatus;
		if (status !== "pending") {
			throw new Error(
				`History cursor at limit ${limit} observed post-snapshot status ${String(status)}.`
			);
		}
		historyBoundaryChecks.push({ limit, passed: true });
	}

	const catalogWarm50 = await sampleLatency(30, async () => {
		await rebuild.store.listSessionsPage({ limit: 50 });
	});
	const catalogWarm200 = await sampleLatency(30, async () => {
		await rebuild.store.listSessionsPage({ limit: 200 });
	});
	const historyWarm50 = await sampleLatency(30, async () => {
		await rebuild.store.readSessionHistoryPage(checkpointSessionId, {
			limit: 50,
		});
	});
	const historyWarm200 = await sampleLatency(30, async () => {
		await rebuild.store.readSessionHistoryPage(checkpointSessionId, {
			limit: 200,
		});
	});
	const coldStatistics = await measure(async () => {
		const statistics =
			await rebuild.store.getSessionStatistics(checkpointSessionId);
		if (statistics.recordCount !== checkpointCount) {
			throw new Error(
				`Statistics returned ${statistics.recordCount} checkpoints.`
			);
		}
		return {
			recordCount: statistics.recordCount,
			usageContributionCount: statistics.usage.actual.contributionCount,
		};
	});
	const statisticsWarm = await sampleLatency(30, async () => {
		await rebuild.store.getSessionStatistics(checkpointSessionId);
	});
	console.log("warm page and statistics samples complete");

	const catchupRecordId = await appendOneRecord(
		checkpointPath,
		checkpointSessionId,
		checkpointCount
	);
	const catchup = await measure(async () => {
		const page = await rebuild.store.readSessionHistoryPage(
			checkpointSessionId,
			{
				limit: 50,
			}
		);
		if (page.records.at(-1)?.id !== catchupRecordId) {
			throw new Error(
				"The newly appended checkpoint was not visible after catch-up."
			);
		}
		return { visible: true };
	});

	const report = {
		benchmark: "Session JSONL integration fixture",
		measuredAt,
		data: {
			checkpointCount,
			sessionCount,
			sameTimestamp: fixedTimestamp,
		},
		environment: {
			architecture: os.arch(),
			bun: Bun.version,
			cpu: os.cpus()[0]?.model ?? "unknown",
			memoryBytes: os.totalmem(),
			os: `${os.platform()} ${os.release()}`,
		},
		fixtureSetup: {
			checkpointAppendMs: percentage(checkpointSeed.durationMs),
			sessionSeedMs: percentage(sessionSeed.durationMs),
			syncPolicy:
				"fixture creation skips per-event sync; cold reads use default sync; appended catch-up event is synced",
		},
		phases: {
			coldCatchup: {
				durationMs: percentage(catchup.durationMs),
				peakRssBytes: catchup.peakRssBytes,
				...catchup.value,
			},
			coldDiscovery:
				discovery === undefined
					? { skipped: true }
					: {
							durationMs: percentage(discovery.durationMs),
							peakRssBytes: discovery.peakRssBytes,
							...discovery.value,
						},
			coldRebuild: {
				durationMs: percentage(coldRebuild.durationMs),
				peakRssBytes: coldRebuild.peakRssBytes,
				...coldRebuild.value,
			},
			coldStatistics: {
				durationMs: percentage(coldStatistics.durationMs),
				peakRssBytes: coldStatistics.peakRssBytes,
				...coldStatistics.value,
			},
			warmCatalog50: catalogWarm50,
			warmCatalog200: catalogWarm200,
			warmHistory50: historyWarm50,
			warmHistory200: historyWarm200,
			warmStatistics: statisticsWarm,
		},
		validation: {
			catalogPage50Count: catalogPage50.sessions.length,
			catalogPage200Count: catalogPage200.sessions.length,
			catalogStatusRevisionFixedByCursor: true,
			historyBoundaryChecks,
			historyPage50Count: Math.min(50, checkpointCount),
			historyPage200Count: Math.min(200, checkpointCount),
			sameTimestampCatalogOrder: true,
			sameTimestampHistoryOrder: true,
		},
	};
	await Bun.write(
		process.env.BENCH_REPORT_PATH ?? "/tmp/session-jsonl-247-benchmark.json",
		JSON.stringify(report, null, 2)
	);
	console.log(JSON.stringify(report, null, 2));
} finally {
	for (const connection of databaseConnections.reverse()) {
		connection.close();
	}
	await fs.rm(root, { recursive: true, force: true });
}
