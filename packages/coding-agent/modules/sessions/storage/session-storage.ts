import type { PluginSessionState } from "./plugin-session-state";
import type { SessionAttachments } from "./session-attachments";
import type { SessionCatalog } from "./session-catalog";
import type { SessionHistory } from "./session-history";
import type { SessionLifecycle } from "./session-lifecycle";
import type { SessionRecords } from "./session-records";

/**
 * The six Session facets as one value: what the factory returns and what a
 * composition root holds so it can hand each host module the one facet it uses.
 * A module that declares `SessionRecords` or `SessionCatalog` compiles against
 * that facet alone, so nothing downstream can depend on the merged surface.
 *
 * Prefer the facet a module actually uses: a host module, an SDK operation or a
 * UI view should declare `SessionRecords`, `SessionHistory` or whichever facet it
 * needs, and only composition roots and entry points hold this merged value.
 * `PromptHistory` is deliberately absent: it is workspace state sharing the same
 * connection, not a Session facet.
 */
export type SessionStorage = SessionRecords &
	SessionCatalog &
	SessionHistory &
	SessionLifecycle &
	SessionAttachments &
	PluginSessionState;
