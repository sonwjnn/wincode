import { createElement, useEffect, useRef } from "react";
import type { ProjectTrustDecision } from "@/modules/project-trust/project-trust";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type ProjectTrustChoice = Readonly<{
	description: string;
	decision: ProjectTrustDecision;
	label: string;
}>;

const TRUST_CHOICES: readonly ProjectTrustChoice[] = [
	{
		description:
			"Allow project Plugins and resources to run with Wincode privileges.",
		decision: "trust",
		label: "Trust this project",
	},
	{
		description: "Skip protected project resources during this reload.",
		decision: "deny",
		label: "Keep untrusted",
	},
];

type ProjectTrustDialogContentProps = Readonly<{
	onCancel: () => void;
	onDecision: (decision: ProjectTrustDecision) => void;
	projectRoot: string;
}>;

export function ProjectTrustDialogContent({
	onCancel,
	onDecision,
	projectRoot,
}: ProjectTrustDialogContentProps) {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const settled = useRef(false);
	const onCancelRef = useRef(onCancel);
	const onDecisionRef = useRef(onDecision);
	onCancelRef.current = onCancel;
	onDecisionRef.current = onDecision;

	useEffect(
		() => () => {
			if (!settled.current) {
				settled.current = true;
				onCancelRef.current();
			}
		},
		[]
	);

	useDialogEscape();

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.text} wrapMode="word">
				{`Project resources in ${projectRoot} may load executable Plugins with Wincode's process privileges. This is not a sandbox.`}
			</text>
			<SearchListDialogWrapper<ProjectTrustChoice>
				getKey={(choice) => choice.decision}
				getSearchText={(choice) => `${choice.label} ${choice.description}`}
				items={TRUST_CHOICES}
				onSelect={(choice) => {
					settled.current = true;
					onDecision(choice.decision);
					dialog.close();
				}}
				placeholder="Choose trust decision"
				renderItem={(choice, isSelected) => (
					<SelectableDialogItem>
						<box flexDirection="column" flexGrow={1}>
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{choice.label}
							</text>
							<text
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
							>
								{choice.description}
							</text>
						</box>
					</SelectableDialogItem>
				)}
				showSearch={false}
			/>
		</box>
	);
}

export const requestProjectTrust = (
	dialog: Pick<DialogContextValue, "open">,
	projectRoot: string
): Promise<ProjectTrustDecision> => {
	const deferred = Promise.withResolvers<ProjectTrustDecision>();
	let settled = false;
	const decide = (decision: ProjectTrustDecision): void => {
		if (settled) {
			return;
		}
		settled = true;
		deferred.resolve(decision);
	};
	dialog.open({
		children: createElement(ProjectTrustDialogContent, {
			onCancel: () =>
				deferred.reject(new Error("Project trust prompt was cancelled.")),
			onDecision: decide,
			projectRoot,
		}),
		title: "Project Trust",
	});
	return deferred.promise;
};
