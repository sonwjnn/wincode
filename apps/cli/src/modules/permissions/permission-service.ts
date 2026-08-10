/**
 * The action a grant or approval is keyed by. Static coding tools use a fixed
 * `PermissionAction` (`read`, `edit`, ...); MCP tools use their logical
 * `<sanitizedServer>_<sanitizedTool>` name. Both are plain strings here so the
 * service stays independent of any one tool family.
 */
export type PermissionGrantAction = string;

/**
 * One remembered "always" approval: the exact evaluated Permission action and
 * canonical resource. Grants match a later request only when both fields are
 * identical, so a grant never widens to cover a sibling resource or action.
 */
export type TemporaryGrant = {
	action: PermissionGrantAction;
	resource: string;
};

export type PermissionServiceListener = () => void;

/**
 * The generic Permission approval service. It owns the process-lifetime,
 * workspace-scoped temporary-grant store and the auto-approval flag shared
 * across every Agent and conversation in the workspace. It is deliberately
 * independent of any one tool family so static coding tools, MCP tools, and
 * future tools all resolve approvals through the same state.
 */
export type PermissionService = {
	isGranted(action: PermissionGrantAction, resource: string): boolean;
	grant(action: PermissionGrantAction, resource: string): void;
	revoke(action: PermissionGrantAction, resource: string): void;
	listGrants(): TemporaryGrant[];
	isAutoApproval(): boolean;
	setAutoApproval(enabled: boolean): void;
	/** Subscribes to grant/auto changes; returns an unsubscribe function. */
	subscribe(listener: PermissionServiceListener): () => void;
};

// Static action names are a fixed set and logical MCP names are sanitized, so
// neither contains a space; the first space therefore unambiguously delimits the
// action from the resource, and two distinct (action, resource) pairs never
// collide onto one key even when a resource contains spaces.
const GRANT_KEY_SEPARATOR = " ";

const grantKey = (action: PermissionGrantAction, resource: string): string =>
	`${action}${GRANT_KEY_SEPARATOR}${resource}`;

export type CreatePermissionServiceOptions = {
	autoApproval?: boolean;
};

/**
 * Creates an isolated Permission service. Each instance is independent: grants
 * and the auto flag live only in this instance's closure, so two services (a
 * second workspace, another CLI process, or a test) never share state.
 */
export function createPermissionService(
	options: CreatePermissionServiceOptions = {}
): PermissionService {
	const grants = new Map<string, TemporaryGrant>();
	const listeners = new Set<PermissionServiceListener>();
	let autoApproval = options.autoApproval ?? false;

	const notify = (): void => {
		for (const listener of listeners) {
			listener();
		}
	};

	return {
		isGranted(action, resource) {
			return grants.has(grantKey(action, resource));
		},
		grant(action, resource) {
			const key = grantKey(action, resource);
			if (grants.has(key)) {
				return;
			}
			grants.set(key, { action, resource });
			notify();
		},
		revoke(action, resource) {
			if (grants.delete(grantKey(action, resource))) {
				notify();
			}
		},
		listGrants() {
			return [...grants.values()].sort((first, second) =>
				first.action === second.action
					? first.resource.localeCompare(second.resource)
					: first.action.localeCompare(second.action)
			);
		},
		isAutoApproval() {
			return autoApproval;
		},
		setAutoApproval(enabled) {
			if (autoApproval === enabled) {
				return;
			}
			autoApproval = enabled;
			notify();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
