import { expect, test } from "bun:test";
import type { Session } from "@/modules/sessions/session-pagination-types";
import type {
	ProjectedSessionRead,
	ProjectedSessionStateRead,
} from "@/modules/sessions/storage/projected-session";
import type { createSessionJsonlStore } from "@/modules/sessions/storage/session-jsonl-store";

type OrchestrationProjectionStore = Parameters<
	typeof createSessionJsonlStore
>[0];

const readSessionThroughProjectedCapability = (
	view: ProjectedSessionRead
): Promise<Session> => view.getSession();

const readPluginStateThroughProjectedCapability = (
	snapshot: ProjectedSessionStateRead
) => snapshot.getPluginSessionState("example", "key");

const orchestrationCannotReadRawProjection = (
	projectionStore: OrchestrationProjectionStore,
	view: ProjectedSessionRead
): void => {
	// @ts-expect-error Facet orchestration receives no raw session reader.
	void projectionStore.getSession;
	// @ts-expect-error Facet orchestration receives no raw catalog reader.
	void projectionStore.readSessionCatalogPageProjection;
	// @ts-expect-error Read views expose domain operations, not arbitrary callbacks.
	void view.read;
};

test("projection reads require a ProjectedSession domain operation", () => {
	expect(typeof readSessionThroughProjectedCapability).toBe("function");
	expect(typeof readPluginStateThroughProjectedCapability).toBe("function");
	expect(typeof orchestrationCannotReadRawProjection).toBe("function");
});
