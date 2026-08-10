import type {
	ConfigDocument,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	DEFAULT_PERMISSION_RULES,
	foldPermissionRules,
	type PermissionRules,
	shippedAgentPermissionRules,
} from "./policy";
import { topLevelPermissionSchema } from "./schema";

const parsePermissionRules = (raw: unknown): PermissionRules | undefined => {
	if (raw === undefined) {
		return;
	}
	const parsed = topLevelPermissionSchema.safeParse(raw);
	return parsed.success ? (parsed.data as PermissionRules) : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const agentPermissionRaw = (
	document: ConfigDocument,
	agentId: string
): unknown => {
	const agents = document.agents;
	if (!isRecord(agents)) {
		return;
	}
	const agent = agents[agentId];
	return isRecord(agent) ? agent.permission : undefined;
};

/**
 * Resolves the effective Permission rules for one selected Agent using
 * source-first precedence: the Wincode defaults and the Agent's shipped
 * restrictions come first, then each config source from low to high precedence,
 * with a source's top-level policy applied before that Agent's policy. Only
 * valid Permission subtrees participate; malformed subtrees are skipped so lower
 * precedence rules stay in effect.
 */
export const resolveAgentPermissionRules = (
	snapshot: ConfigSnapshot,
	agentId: string
): PermissionRules => {
	const layers: PermissionRules[] = [
		DEFAULT_PERMISSION_RULES,
		shippedAgentPermissionRules(agentId),
	];
	for (const source of snapshot.sources) {
		const topLevel = parsePermissionRules(source.document.permission);
		if (topLevel !== undefined) {
			layers.push(topLevel);
		}
		const agentLevel = parsePermissionRules(
			agentPermissionRaw(source.document, agentId)
		);
		if (agentLevel !== undefined) {
			layers.push(agentLevel);
		}
	}
	return foldPermissionRules(layers);
};
