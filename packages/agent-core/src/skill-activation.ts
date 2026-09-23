export const SKILL_ACTIVATION_SOURCES = ["explicit", "agent"] as const;
export type SkillActivationSource = (typeof SKILL_ACTIVATION_SOURCES)[number];
