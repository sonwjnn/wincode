export const SKILL_ACTIVATION_SOURCES = ["explicit", "agent"] as const;
export type SkillActivationSource = (typeof SKILL_ACTIVATION_SOURCES)[number];

export type SkillScope = "global" | "project";
export type SkillFrontmatter = {
	name: string;
	description: string;
	[key: string]: unknown;
};

/**
 * A parsed Skill independent of its discovery backend. Filesystem metadata is
 * optional so callers can construct in-memory catalogs without a platform
 * dependency; the filesystem export fills it when loading a file.
 */
export type Skill = SkillFrontmatter & {
	baseDirectory?: string;
	body: string;
	contentHash?: string;
	filePath: string;
	scope: SkillScope;
};

export type SkillContext = {
	arguments: string;
	instructions: string;
	name: string;
};

export type SkillInvocation = { name: string; arguments: string };

/**
 * The body-bearing snapshot used to inject a Skill into one model turn.
 * Activation metadata deliberately omits the body and instructions.
 */
export type SkillRequestContext = SkillContext & {
	contentHash: string;
	source: SkillActivationSource;
};

export type SkillActivation = {
	arguments?: string;
	contentHash: string;
	name: string;
	source: SkillActivationSource;
};

export type SkillPermissionDecision = "allow" | "ask" | "deny";

export type SkillToolDefinition = {
	description: string;
	inputSchema: {
		additionalProperties: false;
		properties: { name: { type: "string" } };
		required: ["name"];
		type: "object";
	};
	name: "skill";
};

/**
 * The structural shape of a dynamic `skill` UI part. It intentionally does
 * not import an AI SDK message type so the Skills package stays portable.
 */
export type SkillToolPart =
	| {
			errorText?: never;
			input: unknown;
			output: unknown;
			state: "output-available";
			toolCallId: string;
			toolName: string;
			type: "dynamic-tool";
	  }
	| {
			errorText: string;
			input: unknown;
			output?: never;
			state: "output-error";
			toolCallId: string;
			toolName: string;
			type: "dynamic-tool";
	  };
