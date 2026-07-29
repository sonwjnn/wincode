export type SkillFrontmatter = {
	name: string;
	description: string;
	[key: string]: string | string[];
};

export type Skill = SkillFrontmatter & {
	body: string;
	filePath: string;
	scope: "global" | "project";
};

export type SkillCandidate = {
	filePath: string;
	scope: "global" | "project";
	root: string;
};

export type SkillInvocation = { name: string; arguments: string };
