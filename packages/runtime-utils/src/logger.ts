// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as fs from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as path from "node:path";
import type { JsonValue } from "type-fest";

const LOG_RETENTION_DAYS = 14;
const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD_PATTERN =
	/(?:password|passwd|secret|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;
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
	try {
		const url = new URL(value);
		let changed = false;
		if (url.username.length > 0) {
			url.username = REDACTED;
			changed = true;
		}
		if (url.password.length > 0) {
			url.password = REDACTED;
			changed = true;
		}
		for (const [name] of [...url.searchParams]) {
			if (isSensitiveField(name)) {
				url.searchParams.set(name, REDACTED);
				changed = true;
			}
		}
		return changed ? url.toString() : value;
	} catch {
		return value;
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
const removeExpiredLogs = (directory: string, currentDate: string): void => {
	const checkKey = `${directory}\0${currentDate}`;
	if (checkKey === lastRetentionCheck) {
		return;
	}
	lastRetentionCheck = checkKey;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}

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
		try {
			fs.unlinkSync(path.join(directory, entry.name));
		} catch {
			// Retention is best-effort; a stale log must not prevent a new record.
		}
	}
};

const writeRecord = (
	level: LoggerLevel,
	message: string,
	fields?: LogFields
): void => {
	if (level === "debug" && process.env.WINCODE_DEBUG !== "1") {
		return;
	}
	try {
		const timestamp = new Date();
		const currentDate = dateString(timestamp);
		const directory = path.join(
			process.env.HOME || os.homedir(),
			".wincode",
			"logs"
		);
		fs.mkdirSync(directory, { mode: 0o700, recursive: true });
		removeExpiredLogs(directory, currentDate);
		const record = {
			timestamp: timestamp.toISOString(),
			level,
			message,
			...(fields === undefined ? {} : { context: redactValue(fields) }),
		};
		const line = JSON.stringify(record);
		if (line !== undefined) {
			fs.appendFileSync(
				path.join(directory, `wincode.${currentDate}.log`),
				`${line}\n`,
				{ encoding: "utf8", mode: 0o600 }
			);
		}
	} catch {
		// Diagnostics must never interrupt a runtime or contaminate its output streams.
	}
};

/**
 * File-backed diagnostics that never write to CLI or protocol output streams.
 * Keep message text non-secret; credential redaction applies to fields only.
 */
export const logger = Object.freeze({
	debug: (message: string, fields?: LogFields): void =>
		writeRecord("debug", message, fields),
	error: (message: string, fields?: LogFields): void =>
		writeRecord("error", message, fields),
	warn: (message: string, fields?: LogFields): void =>
		writeRecord("warn", message, fields),
});
