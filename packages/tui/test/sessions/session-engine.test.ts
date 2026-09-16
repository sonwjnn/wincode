import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import { createSessionEngine } from "@/modules/sessions/engine/session-engine";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	compactionId,
	modelId,
	sessionId,
	sessionMessageId,
} from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const message = (id: string, text = id): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text, type: "text" }],
		role: "user",
	});

const compaction = (id: string, sequence: number): SessionCompaction => ({
	completedAt: new Date("2026-08-30T00:00:00.000Z"),
	createdAt: new Date("2026-08-30T00:00:00.000Z"),
	estimatedTokensAfter: 20,
	firstKeptUiMessageId: sessionMessageId("u2"),
	id: compactionId(id),
	sequence,
	sessionId: sessionId("session-engine"),
	summarizationModel: model,
	summary: {
		coveredMessageIds: [sessionMessageId("u1")],
		formatVersion: 1,
		text: "summary",
	},
	throughMessageUiId: sessionMessageId("u2"),
	tokensBefore: 100,
	trigger: "manual",
});

test("merges a message into the Session Transcript by id", () => {
	const engine = createSessionEngine({
		initialTranscript: [message("u1", "first request")],
	});

	const merged = engine.mergeTranscript([
		message("a1", "answer"),
		message("u1", "edited request"),
	]);

	expect(merged.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(merged[0]?.parts[0]).toMatchObject({ text: "edited request" });
});

test("keeps a compaction summary out of the Session Transcript", () => {
	const engine = createSessionEngine({
		initialTranscript: [message("u1")],
	});

	engine.mergeTranscript([message("compaction:entry-1", "summary")]);

	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
	]);
});

test("keeps the Session Context independent from the Session Transcript", () => {
	const engine = createSessionEngine({
		initialTranscript: [message("u1"), message("a1")],
	});

	engine.applyContext([message("compaction:entry-1")]);
	engine.mergeTranscript([message("a2")]);

	expect(engine.getSnapshot().context.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-1"),
	]);
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
		sessionMessageId("a2"),
	]);
});

test("publishes a new Session Snapshot only when a fact changes", () => {
	const engine = createSessionEngine({ initialTranscript: [] });
	const initial = engine.getSnapshot();
	let notifications = 0;
	const unsubscribe = engine.subscribe(() => {
		notifications += 1;
	});

	engine.setStatus("ready");
	expect(engine.getSnapshot()).toBe(initial);
	expect(notifications).toBe(0);

	engine.setStatus("streaming");
	expect(engine.getSnapshot()).not.toBe(initial);
	expect(engine.getSnapshot().status).toBe("streaming");
	expect(notifications).toBe(1);

	unsubscribe();
	engine.setStatus("ready");
	expect(notifications).toBe(1);
});

test("isolates a failing observer from session state and other observers", () => {
	const engine = createSessionEngine({ initialTranscript: [] });
	let observed = 0;
	engine.subscribe(() => {
		throw new Error("observer failed");
	});
	engine.subscribe(() => {
		observed += 1;
	});

	engine.setStatus("submitted");

	expect(engine.getSnapshot().status).toBe("submitted");
	expect(observed).toBe(1);
});

test("records a compaction entry once per Compaction Identifier", () => {
	const engine = createSessionEngine({ initialTranscript: [] });

	engine.recordCompaction(compaction("entry-1", 1));
	engine.recordCompaction(compaction("entry-1", 1));

	expect(engine.getSnapshot().compactions.map(({ id }) => id)).toEqual([
		compactionId("entry-1"),
	]);
});
