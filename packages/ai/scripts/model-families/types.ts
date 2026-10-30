/** Build-time family labels; family classification is not Provider Model identity. */
export const providerModelFamilyIds = [
	"anthropic",
	"deepseek",
	"google",
	"openai",
] as const;

export type ProviderModelFamilyId = (typeof providerModelFamilyIds)[number];
