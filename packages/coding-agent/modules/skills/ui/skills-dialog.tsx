import { TextAttributes } from "@opentui/core";
import { useCallback, useEffect, useState } from "react";
import {
	discoverSkills,
	getSkillSearchText,
	SKILL_NAMESPACE_PREFIX,
	type Skill,
} from "@/modules/skills";
import { useConfig } from "@/shared/config/config-provider";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

export const SKILLS_DIALOG_WIDTH = 84;
const MAX_SKILL_NAME_COLUMN_WIDTH = 32;
const MIN_SKILL_NAME_COLUMN_WIDTH = 20;
const MAX_VISIBLE_SKILLS = 16;

type SkillsDialogContentProps = {
	onSelectSkill: (command: string) => void;
};

type SkillLoadStatus = "error" | "loading" | "ready";

export function SkillsDialogContent({
	onSelectSkill,
}: SkillsDialogContentProps) {
	const [skills, setSkills] = useState<Skill[]>([]);
	const [status, setStatus] = useState<SkillLoadStatus>("loading");
	const dialog = useDialog();
	const { colors } = useTheme();
	const config = useConfig();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const skillNameColumnWidth = Math.min(
		MAX_SKILL_NAME_COLUMN_WIDTH,
		skills.reduce(
			(width, { name }) => Math.max(width, name.length),
			MIN_SKILL_NAME_COLUMN_WIDTH
		)
	);

	useEffect(() => {
		let cancelled = false;

		const loadSkills = async () => {
			try {
				const discovered = await discoverSkills(config);
				if (!cancelled) {
					setSkills(discovered);
					setStatus("ready");
				}
			} catch {
				if (!cancelled) {
					setStatus("error");
				}
			}
		};

		void loadSkills();
		return () => {
			cancelled = true;
		};
	}, [config]);

	const handleSelect = useCallback(
		(skill: Skill) => {
			onSelectSkill(`/${SKILL_NAMESPACE_PREFIX}${skill.name} `);
			dialog.close();
		},
		[dialog, onSelectSkill]
	);

	useDialogEscape();

	let emptyText = "No matching skills";
	if (status === "loading") {
		emptyText = "Loading skills...";
	} else if (status === "error") {
		emptyText = "Could not load skills";
	}

	return (
		<SearchListDialogWrapper
			emptyText={emptyText}
			getKey={(skill) => skill.name}
			getSearchText={getSkillSearchText}
			items={skills}
			maxVisibleItems={MAX_VISIBLE_SKILLS}
			minVisibleItems={MAX_VISIBLE_SKILLS}
			onSelect={handleSelect}
			placeholder="Search skills"
			renderItem={(skill, isSelected) => (
				<SelectableDialogItem>
					<box flexDirection="row" flexGrow={1} gap={2} overflow="hidden">
						<box flexShrink={0} width={skillNameColumnWidth}>
							<text
								attributes={isSelected ? TextAttributes.BOLD : undefined}
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
								wrapMode="none"
							>
								{skill.name}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								attributes={isSelected ? undefined : TextAttributes.DIM}
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
								wrapMode="none"
							>
								{skill.description}
							</text>
						</box>
					</box>
				</SelectableDialogItem>
			)}
		/>
	);
}
