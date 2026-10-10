import { createElement, useEffect, useRef } from "react";
import type {
	ProjectTrustDecision,
	ProjectTrustSavedDecision,
} from "@/modules/project-trust/project-trust";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type ProjectTrustSelection = ProjectTrustDecision | "trust-parent";

type ProjectTrustChoice = Readonly<{
	action: ProjectTrustSelection;
	description: string;
	label: string;
}>;

const getTrustChoices = (
	parentDirectory?: string
): readonly ProjectTrustChoice[] => [
	{
		action: "trust",
		description: "Allow this project's protected resources to load.",
		label: "Trust",
	},
	...(parentDirectory === undefined
		? []
		: [
				{
					action: "trust-parent" as const,
					description: "Trust the parent folder and its descendant projects.",
					label: `Trust parent folder (${parentDirectory})`,
				},
			]),
	{
		action: "deny",
		description: "Keep protected project resources disabled.",
		label: "Do not trust",
	},
];

type ProjectTrustDialogContentProps = Readonly<{
	currentSessionTrusted: boolean;
	onCancel: () => void;
	onDecision: (choice: ProjectTrustSelection) => void;
	parentDirectory?: string;
	projectRoot: string;
	savedDecision?: ProjectTrustSavedDecision;
}>;

export function ProjectTrustDialogContent({
	currentSessionTrusted,
	onCancel,
	onDecision,
	parentDirectory,
	projectRoot,
	savedDecision,
}: ProjectTrustDialogContentProps) {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const choices = getTrustChoices(parentDirectory);
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
			<text fg={colors.textMuted} wrapMode="word">
				{projectRoot}
			</text>
			<text fg={colors.textMuted} wrapMode="word">
				{`Saved decision: ${savedDecision === undefined ? "none" : `${savedDecision.decision === "trust" ? "trusted" : "untrusted"}${savedDecision.inherited ? ` (inherited from ${savedDecision.directory})` : ""}`}`}
			</text>
			<text fg={colors.textMuted} wrapMode="word">
				{`Current session: ${currentSessionTrusted ? "trusted" : "untrusted"}`}
			</text>
			<text fg={colors.text} wrapMode="word">
				Project Plugins, MCP Servers, and other protected resources may run with
				Wincode's process privileges. This is not a sandbox.
			</text>
			<SearchListDialogWrapper<ProjectTrustChoice>
				getKey={(choice) => choice.action}
				getSearchText={(choice) => `${choice.label} ${choice.description}`}
				items={choices}
				onSelect={(choice) => {
					settled.current = true;
					onDecision(choice.action);
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

type ProjectTrustRequest = Omit<
	ProjectTrustDialogContentProps,
	"onCancel" | "onDecision"
>;

export const requestProjectTrust = (
	dialog: Pick<DialogContextValue, "open">,
	request: ProjectTrustRequest
): Promise<ProjectTrustSelection> => {
	const deferred = Promise.withResolvers<ProjectTrustSelection>();
	let settled = false;
	const decide = (decision: ProjectTrustSelection): void => {
		if (settled) {
			return;
		}
		settled = true;
		deferred.resolve(decision);
	};
	dialog.open({
		children: createElement(ProjectTrustDialogContent, {
			...request,
			onCancel: () =>
				deferred.reject(new Error("Project trust prompt was cancelled.")),
			onDecision: decide,
		}),
		title: "Project Trust",
	});
	return deferred.promise;
};
