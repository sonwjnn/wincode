import { TextAttributes } from "@opentui/core";
import type { Skill } from "@wincode/skills";
import { useCallback, useEffect, useState } from "react";
import { discoverSkills } from "@/modules/skills";
import { useConfig } from "@/shared/config/config-provider";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

export const SKILLS_DIALOG_WIDTH = 84;
const MIN_SKILL_NAME_COLUMN_WIDTH = 24;
const MAX_VISIBLE_SKILL_ITEMS = 16;
const SKILLS_HEADER_ITEM_COUNT = 1;
const SKILLS_VISIBLE_ROW_COUNT =
	MAX_VISIBLE_SKILL_ITEMS + SKILLS_HEADER_ITEM_COUNT;

type SkillRow =
	| { kind: "header"; label: string }
	| { kind: "skill"; skill: Skill };

type SkillsDialogContentProps = {
	onSelectSkill: (command: string) => void;
};

export function SkillsDialogContent({
	onSelectSkill,
}: SkillsDialogContentProps) {
	const [skills, setSkills] = useState<Skill[]>([]);
	const [status, setStatus] = useState<"error" | "loading" | "ready">(
		"loading"
	);
	const dialog = useDialog();
	const { colors } = useTheme();
	const config = useConfig();
	const skillNameColumnWidth = Math.max(
		MIN_SKILL_NAME_COLUMN_WIDTH,
		...skills.map((skill) => skill.name.length)
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

		loadSkills().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [config]);

	const handleSelect = useCallback(
		(skill: Skill) => {
			onSelectSkill(`/${skill.name} `);
			dialog.close();
		},
		[dialog, onSelectSkill]
	);

	useDialogEscape();

	const rows: SkillRow[] = skills.length
		? [
				{ kind: "header", label: "Skills" },
				...skills.map((skill) => ({ kind: "skill" as const, skill })),
			]
		: [];
	let emptyText = "No matching skills";
	if (status === "loading") {
		emptyText = "Loading skills...";
	} else if (status === "error") {
		emptyText = "Could not load skills";
	}

	return (
		<SearchListDialogWrapper<SkillRow>
			emptyText={emptyText}
			filterFn={(row, query) => {
				if (row.kind === "header") {
					return query.length === 0;
				}
				return `${row.skill.name} ${row.skill.description}`
					.toLowerCase()
					.includes(query.toLowerCase());
			}}
			getKey={(row) =>
				row.kind === "header" ? "header:skills" : row.skill.name
			}
			isItemSelectable={(row) => row.kind === "skill"}
			items={rows}
			// Reserve the full list viewport so async loading and search do not
			// change the dialog height or its centered position.
			maxVisibleItems={SKILLS_VISIBLE_ROW_COUNT}
			minVisibleItems={SKILLS_VISIBLE_ROW_COUNT}
			onSelect={(row) => row.kind === "skill" && handleSelect(row.skill)}
			placeholder="Search skills..."
			renderItem={(row, isSelected) => {
				if (row.kind === "header") {
					return (
						<SelectableDialogItem>
							<text attributes={TextAttributes.BOLD} fg={colors.primary}>
								{row.label}
							</text>
						</SelectableDialogItem>
					);
				}

				return (
					<SelectableDialogItem>
						<box flexDirection="row" flexGrow={1} gap={2} overflow="hidden">
							<box flexShrink={0} width={skillNameColumnWidth}>
								<text
									fg={isSelected ? "black" : "white"}
									selectable={false}
									wrapMode="none"
								>
									{row.skill.name}
								</text>
							</box>
							<box flexGrow={1} flexShrink={1} overflow="hidden">
								<text
									attributes={isSelected ? undefined : TextAttributes.DIM}
									fg={isSelected ? "black" : "#9AA0A6"}
									selectable={false}
									wrapMode="none"
								>
									{row.skill.description}
								</text>
							</box>
						</box>
					</SelectableDialogItem>
				);
			}}
		/>
	);
}
