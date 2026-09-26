import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as path from "node:path";
import type { JsonValue } from "type-fest";

const LOG_RETENTION_DAYS = 14;
const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD_PATTERN =
	/(?:password|passwd|secret|credential|authorization|cookie|api[_-]?key|access[_-]?key|signature|(?:^|[_-])sig(?:$|[_-])|private[_-]?key)/i;
const AUTH_FIELD_PATTERN = /^auth(?:entication)?(?:[_-]?(?:header|value))?$/i;
const TOKEN_FIELD_PATTERN = /token$/i;
const URL_FIELD_PATTERN = /(?:url|uri|endpoint)$/i;
const LOG_FILE_PATTERN = /^wincode\.(\d{4}-\d{2}-\d{2})\.log$/;

type LoggerLevel = "debug" | "error" | "warn";

/** Non-secret JSON metadata; known credential fields and URL query keys are redacted. */
export type LogFields = Readonly<Record<string, JsonValue>>;

const isSensitiveField = (name: string): boolean =>
	AUTH_FIELD_PATTERN.test(name) ||
	SENSITIVE_FIELD_PATTERN.test(name) ||
	name.toLowerCase() === "key" ||
	TOKEN_FIELD_PATTERN.test(name);

const redactUrl = (value: string): string => {
	const queryStart = value.indexOf("?");
	const fragmentStart = value.indexOf("#");
	let redacted = value;
	if (
		queryStart !== -1 &&
		(fragmentStart === -1 || queryStart < fragmentStart)
	) {
		const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
		const parameters = new URLSearchParams(
			value.slice(queryStart + 1, queryEnd)
		);
		let queryChanged = false;
		for (const [name] of [...parameters]) {
			if (isSensitiveField(name)) {
				parameters.set(name, REDACTED);
				queryChanged = true;
			}
		}
		if (queryChanged) {
			redacted = `${value.slice(0, queryStart + 1)}${parameters.toString()}${value.slice(queryEnd)}`;
		}
	}

	const isNetworkPathReference = redacted.startsWith("//");
	try {
		const url = isNetworkPathReference
			? new URL(redacted, "https://wincode.invalid")
			: new URL(redacted);
		let credentialsChanged = false;
		if (url.username.length > 0) {
			url.username = REDACTED;
			credentialsChanged = true;
		}
		if (url.password.length > 0) {
			url.password = REDACTED;
			credentialsChanged = true;
		}
		if (!credentialsChanged) {
			return redacted;
		}
		const formatted = url.toString();
		return isNetworkPathReference
			? formatted.slice("https:".length)
			: formatted;
	} catch {
		return redacted;
	}
};

const redactValue = (value: JsonValue, fieldName?: string): JsonValue => {
	if (fieldName !== undefined && isSensitiveField(fieldName)) {
		return REDACTED;
	}
	if (
		typeof value === "string" &&
		fieldName !== undefined &&
		URL_FIELD_PATTERN.test(fieldName)
	) {
		return redactUrl(value);
	}
	if (Array.isArray(value)) {
		return value.map((item: JsonValue) => redactValue(item, fieldName));
	}
	if (value !== null && typeof value === "object") {
		const redacted: Record<string, JsonValue> = {};
		for (const [name, nestedValue] of Object.entries(
			value as Readonly<Record<string, JsonValue>>
		)) {
			redacted[name] = redactValue(nestedValue, name);
		}
		return redacted;
	}
	return value;
};

const dateString = (date: Date): string => date.toISOString().slice(0, 10);

let lastRetentionCheck: string | undefined;
const removeExpiredLogs = async (
	directory: string,
	currentDate: string
): Promise<void> => {
	const checkKey = `${directory}\0${currentDate}`;
	if (checkKey === lastRetentionCheck) {
		return;
	}
	lastRetentionCheck = checkKey;

	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => []
	);
	const oldestRetainedDate = new Date(`${currentDate}T00:00:00.000Z`);
	oldestRetainedDate.setUTCDate(
		oldestRetainedDate.getUTCDate() - (LOG_RETENTION_DAYS - 1)
	);
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const match = LOG_FILE_PATTERN.exec(entry.name);
		const datePart = match?.[1];
		if (datePart === undefined) {
			continue;
		}
		const fileDate = new Date(`${datePart}T00:00:00.000Z`);
		if (
			Number.isNaN(fileDate.getTime()) ||
			dateString(fileDate) !== datePart ||
			fileDate >= oldestRetainedDate
		) {
			continue;
		}
		await unlink(path.join(directory, entry.name)).catch(() => undefined);
	}
};
let logQueue = Promise.resolve();
const writeRecord = (
	level: LoggerLevel,
	message: string,
	fields?: LogFields
): Promise<void> => {
	if (level === "debug" && process.env.WINCODE_DEBUG !== "1") {
		return logQueue;
	}
	let directory: string;
	let currentDate: string;
	let line: string;
	try {
		const timestamp = new Date();
		currentDate = dateString(timestamp);
		directory = path.join(process.env.HOME || os.homedir(), ".wincode", "logs");
		const record = {
			timestamp: timestamp.toISOString(),
			level,
			message,
			...(fields === undefined ? {} : { context: redactValue(fields) }),
		};
		const serialized = JSON.stringify(record);
		if (serialized === undefined) {
			return logQueue;
		}
		line = `${serialized}\n`;
	} catch {
		return logQueue;
	}
	logQueue = logQueue.then(async () => {
		try {
			await mkdir(directory, { mode: 0o700, recursive: true });
			await removeExpiredLogs(directory, currentDate);
			await appendFile(
				path.join(directory, `wincode.${currentDate}.log`),
				line,
				{ encoding: "utf8", mode: 0o600 }
			);
		} catch {
			// Diagnostics must never interrupt a runtime or contaminate its output streams.
		}
	});
	return logQueue;
};

/**
 * File-backed diagnostics that never write to CLI or protocol output streams.
 * Keep message text non-secret; credential redaction applies to fields only.
 * Await a call when the runtime must wait for its write attempt.
 */
export const logger = Object.freeze({
	debug: (message: string, fields?: LogFields): Promise<void> =>
		writeRecord("debug", message, fields),
	error: (message: string, fields?: LogFields): Promise<void> =>
		writeRecord("error", message, fields),
	warn: (message: string, fields?: LogFields): Promise<void> =>
		writeRecord("warn", message, fields),
});
