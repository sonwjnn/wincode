/** Low-to-high source order shared by file-backed application resources. */
export const RESOURCE_SOURCE_PRECEDENCE = [
	"package",
	"user-discovered",
	"user-explicit",
	"project-discovered",
	"project-explicit",
] as const;

type ResourceSourceClass = (typeof RESOURCE_SOURCE_PRECEDENCE)[number];
type ResourceSourceScope = "global" | "project" | "user";

export const resourceSourcePrecedence = (source: ResourceSourceClass): number =>
	RESOURCE_SOURCE_PRECEDENCE.indexOf(source);

const resourceSourceClass = (input: {
	explicit: boolean;
	scope: ResourceSourceScope;
}): ResourceSourceClass => {
	if (input.scope === "project") {
		return input.explicit ? "project-explicit" : "project-discovered";
	}
	return input.explicit ? "user-explicit" : "user-discovered";
};

export const resourceSourcePriority = (input: {
	explicit: boolean;
	scope: ResourceSourceScope;
}): number => resourceSourcePrecedence(resourceSourceClass(input));
