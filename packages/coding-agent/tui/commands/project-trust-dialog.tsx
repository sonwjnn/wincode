import { useTerminalDimensions } from "@opentui/react";
import { createElement, useEffect, useRef } from "react";
import type {
	ProjectTrustPromptRequest,
	ProjectTrustSelection,
} from "@/modules/project-trust/project-trust";
import { shortenHomePath } from "@/shared/paths/display-path";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type ProjectTrustChoiceItem = Readonly<{
	action: ProjectTrustSelection;
	description: string;
	label: string;
}>;

const getTrustChoices = (
	parentDirectory?: string
): readonly ProjectTrustChoiceItem[] => [
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
					label: `Trust parent folder (${shortenHomePath(parentDirectory)})`,
				},
			]),
	{
		action: "deny",
		description: "Keep protected project resources disabled.",
		label: "Do not trust",
	},
];

type ProjectTrustDialogContentProps = ProjectTrustPromptRequest &
	Readonly<{
		onCancel: () => void;
		onDecision: (choice: ProjectTrustSelection) => void;
	}>;

export function ProjectTrustDialogContent({
	protectedRoots,
	workspace,
	onCancel,
	onDecision,
	parentDirectory,
}: ProjectTrustDialogContentProps) {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const { height } = useTerminalDimensions();
	const rootStatusHeight = Math.min(6, Math.max(3, protectedRoots.length * 3));
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
			<box flexDirection="column" gap={1} marginX={4}>
				<text fg={colors.textMuted} wrapMode="word">
					{`Workspace: ${shortenHomePath(workspace)}`}
				</text>
				{protectedRoots.length === 0 ? (
					<text fg={colors.textMuted}>
						No protected project resources detected.
					</text>
				) : (
					<scrollbox
						height={Math.min(rootStatusHeight, Math.max(3, height - 18))}
						verticalScrollbarOptions={{ visible: false }}
					>
						{protectedRoots.map(
							({ currentSessionStatus, projectRoot, savedDecision }) => (
								<box flexDirection="column" key={projectRoot}>
									{projectRoot === workspace ? null : (
										<text fg={colors.textMuted} wrapMode="word">
											{`Protected root: ${shortenHomePath(projectRoot)}`}
										</text>
									)}
									<text fg={colors.textMuted} wrapMode="word">
										{`Saved decision: ${savedDecision === undefined ? "none" : `${savedDecision.decision === "trust" ? "trusted" : "untrusted"}${savedDecision.inherited ? ` (inherited from ${shortenHomePath(savedDecision.directory)})` : ""}`}`}
									</text>
									<text fg={colors.textMuted} wrapMode="word">
										{`Current session: ${currentSessionStatus === "pending" ? "Decision pending" : currentSessionStatus}`}
									</text>
								</box>
							)
						)}
					</scrollbox>
				)}
			</box>
			<SearchListDialogWrapper<ProjectTrustChoiceItem>
				footer={
					<box marginX={4}>
						<DialogFooterHint label="navigate" shortcut="↑↓" />
					</box>
				}
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
						<text
							fg={isSelected ? selectedTextColor : colors.text}
							marginX={0}
							selectable={false}
						>
							{choice.label}
						</text>
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
		padding: { bottom: 1, left: 0, right: 0, top: 1 },
		title: "Project Trust",
		titleMargin: { left: 4, right: 4 },
	});
	return deferred.promise;
};
