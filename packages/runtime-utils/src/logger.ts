import { appendFile, chmod, mkdir, readdir, unlink } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as path from "node:path";
import type { JsonValue } from "type-fest";
import { isObjectLike } from "./guards";
import { isSensitiveKey } from "./sensitive-key";

const LOG_RETENTION_DAYS = 14;
const REDACTED = "[REDACTED]";
const URL_FIELD_PATTERN =
	/(?:url|uri|endpoint|redirect|callback|href|link|location)$/i;
const LOG_FILE_PATTERN = /^wincode\.(\d{4}-\d{2}-\d{2})\.log$/;
const URL_AUTHORITY_PREFIX_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const URL_IN_TEXT_PATTERN = /[a-z][a-z\d+.-]*:\/\/[^\s"'<>`]+/gi;
const RELATIVE_URL_IN_TEXT_PATTERN =
	/(?<![\w./-])(?:\.\.?\/|\/|[\w~.+%-]+(?:\/|[?#])|[?#])[^\s"'<>`]+/g;
const URL_TRAILING_PUNCTUATION_PATTERN = /[.,;!)]*$/;
const URL_AUTHORITY_END_PATTERN = /[/?#]/;

type LoggerLevel = "debug" | "error" | "warn";

/** Structured fields with known credential, URL query, and fragment secrets redacted. */
export type LogFields = Readonly<Record<string, JsonValue>>;

const redactUrlAuthorityCredentials = (value: string): string => {
	const schemePrefix = URL_AUTHORITY_PREFIX_PATTERN.exec(value)?.[0];
	const authorityStart =
		schemePrefix?.length ?? (value.startsWith("//") ? 2 : undefined);
	if (authorityStart === undefined) {
		return value;
	}
	const relativeAuthorityEnd = value
		.slice(authorityStart)
		.search(URL_AUTHORITY_END_PATTERN);
	const authorityEnd =
		relativeAuthorityEnd === -1
			? value.length
			: authorityStart + relativeAuthorityEnd;
	const atIndex = value.lastIndexOf("@", authorityEnd - 1);
	if (atIndex < authorityStart) {
		return value;
	}
	const credentials = value.slice(authorityStart, atIndex);
	const replacement = encodeURIComponent(REDACTED);
	const redactedCredentials = credentials.includes(":")
		? `${replacement}:${replacement}`
		: replacement;
	return `${value.slice(0, authorityStart)}${redactedCredentials}${value.slice(atIndex)}`;
};
const redactUrlParameters = (value: string): string => {
	const parameters = new URLSearchParams(value);
	let changed = false;
	for (const name of parameters.keys()) {
		if (isSensitiveKey(name)) {
			parameters.set(name, REDACTED);
			changed = true;
		}
	}
	return changed ? parameters.toString() : value;
};
const redactUrl = (value: string): string => {
	let redacted = value;
	const queryStart = redacted.indexOf("?");
	const initialFragmentStart = redacted.indexOf("#");
	if (
		queryStart !== -1 &&
		(initialFragmentStart === -1 || queryStart < initialFragmentStart)
	) {
		const queryEnd =
			initialFragmentStart === -1 ? redacted.length : initialFragmentStart;
		const query = redacted.slice(queryStart + 1, queryEnd);
		const sanitizedQuery = redactUrlParameters(query);
		if (sanitizedQuery !== query) {
			redacted = `${redacted.slice(0, queryStart + 1)}${sanitizedQuery}${redacted.slice(queryEnd)}`;
		}
	}

	const fragmentStart = redacted.indexOf("#");
	if (fragmentStart !== -1) {
		const fragmentQueryStart = redacted.indexOf("?", fragmentStart + 1);
		const parametersStart =
			fragmentQueryStart === -1 ? fragmentStart + 1 : fragmentQueryStart + 1;
		const fragmentParameters = redacted.slice(parametersStart);
		const sanitizedFragment = redactUrlParameters(fragmentParameters);
		if (sanitizedFragment !== fragmentParameters) {
			redacted = `${redacted.slice(0, parametersStart)}${sanitizedFragment}`;
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
		return redactUrlAuthorityCredentials(redacted);
	}
};
const redactEmbeddedUrl = (matchedUrl: string): string => {
	const punctuation =
		URL_TRAILING_PUNCTUATION_PATTERN.exec(matchedUrl)?.[0] ?? "";
	const url = matchedUrl.slice(0, matchedUrl.length - punctuation.length);
	return `${redactUrl(url)}${punctuation}`;
};
const redactEmbeddedUrls = (value: string): string =>
	value
		.replace(URL_IN_TEXT_PATTERN, redactEmbeddedUrl)
		.replace(RELATIVE_URL_IN_TEXT_PATTERN, redactEmbeddedUrl);

const redactArray = (value: JsonValue[], fieldName?: string): JsonValue[] => {
	let redacted: JsonValue[] | undefined;
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) {
			continue;
		}
		const item = value[index] as JsonValue;
		const redactedItem = redactValue(item, fieldName);
		if (redactedItem !== item) {
			redacted ??= value.slice();
			redacted[index] = redactedItem;
		}
	}
	return redacted ?? value;
};
const redactObject = (
	value: Record<string, JsonValue>
): Record<string, JsonValue> => {
	let redacted: Record<string, JsonValue> | undefined;
	for (const name in value) {
		if (!Object.hasOwn(value, name)) {
			continue;
		}
		const nestedValue = value[name] as JsonValue;
		const redactedValue = redactValue(nestedValue, name);
		if (redactedValue !== nestedValue) {
			redacted ??= { ...value };
			redacted[name] = redactedValue;
		}
	}
	return redacted ?? value;
};
function redactValue(value: JsonValue, fieldName?: string): JsonValue {
	if (fieldName !== undefined && isSensitiveKey(fieldName)) {
		return REDACTED;
	}
	if (typeof value === "string") {
		if (
			(fieldName !== undefined && URL_FIELD_PATTERN.test(fieldName)) ||
			URL_AUTHORITY_PREFIX_PATTERN.test(value) ||
			value.startsWith("//") ||
			value.startsWith("/") ||
			value.startsWith("?") ||
			value.startsWith("#")
		) {
			return redactEmbeddedUrls(redactUrl(value));
		}
		if (value.includes("/") || value.includes("?") || value.includes("#")) {
			return redactEmbeddedUrls(value);
		}
	}
	if (Array.isArray(value)) {
		return redactArray(value as JsonValue[], fieldName);
	}
	if (value !== null && typeof value === "object") {
		return redactObject(value as Record<string, JsonValue>);
	}
	return value;
}

const dateString = (date: Date): string => date.toISOString().slice(0, 10);
const isMissingPathError = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

let lastRetentionCheck: string | undefined;
const removeExpiredLogs = async (
	directory: string,
	currentDate: string
): Promise<void> => {
	const checkKey = `${directory}\0${currentDate}`;
	if (checkKey === lastRetentionCheck) {
		return;
	}

	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => undefined
	);
	if (entries === undefined) {
		return;
	}
	const oldestRetainedDate = new Date(`${currentDate}T00:00:00.000Z`);
	oldestRetainedDate.setUTCDate(
		oldestRetainedDate.getUTCDate() - (LOG_RETENTION_DAYS - 1)
	);
	let sweepSucceeded = true;
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
			await unlink(path.join(directory, entry.name));
		} catch {
			sweepSucceeded = false;
		}
	}
	if (sweepSucceeded) {
		lastRetentionCheck = checkKey;
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
			await chmod(directory, 0o700);
			const logFile = path.join(directory, `wincode.${currentDate}.log`);
			try {
				await chmod(logFile, 0o600);
			} catch (error) {
				if (!isMissingPathError(error)) {
					throw error;
				}
			}
			await appendFile(logFile, line, {
				encoding: "utf8",
				mode: 0o600,
			});
		} catch {
			// Diagnostics must never interrupt a runtime or contaminate its output streams.
		}
	});
	return logQueue;
};

/**
 * File-backed diagnostics that never write to CLI or protocol output streams.
 * Keep message text non-secret; credential redaction applies to fields only.
 * Await a call when the runtime must wait for its write attempt; `flush` waits for earlier queued writes.
 */
export const logger = Object.freeze({
	debug: (message: string, fields?: LogFields): Promise<void> =>
		writeRecord("debug", message, fields),
	error: (message: string, fields?: LogFields): Promise<void> =>
		writeRecord("error", message, fields),
	warn: (message: string, fields?: LogFields): Promise<void> =>
		writeRecord("warn", message, fields),
	flush: (): Promise<void> => logQueue,
});
