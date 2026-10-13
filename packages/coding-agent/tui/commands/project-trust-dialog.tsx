import { useTerminalDimensions } from "@opentui/react";
import { createElement, useEffect, useMemo, useRef, useState } from "react";
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
import { DialogInset } from "@/shared/ui/dialog-inset";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type ProjectTrustChoiceItem = Readonly<{
	action: ProjectTrustSelection;
	description: string;
	label: string;
}>;

const getTrustChoices = (
	parentDirectory: string | undefined,
	includeSessionOnly: boolean
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
	...(includeSessionOnly
		? [
				{
					action: "trust-session" as const,
					description:
						"Load protected resources until Wincode exits; save no decision.",
					label: "Trust (this session only)",
				},
			]
		: []),
	{
		action: "deny",
		description: "Keep this project's protected resources disabled.",
		label: "Do not trust",
	},
	...(includeSessionOnly
		? [
				{
					action: "deny-session" as const,
					description:
						"Disable protected resources until Wincode exits; save no decision.",
					label: "Do not trust (this session only)",
				},
			]
		: []),
];

type ProjectTrustDialogContentProps = ProjectTrustPromptRequest &
	Readonly<{
		onCancel: () => void;
		onDecision: (choice: ProjectTrustSelection) => void;
		/** The startup prompt offers throwaway decisions; /trust does not. */
		includeSessionOnly?: boolean;
	}>;

export function ProjectTrustDialogContent({
	protectedRoots,
	workspace,
	onCancel,
	onDecision,
	parentDirectory,
	includeSessionOnly = false,
}: ProjectTrustDialogContentProps) {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const { height } = useTerminalDimensions();
	const rootStatusHeight = Math.min(6, Math.max(3, protectedRoots.length * 3));
	const choices = useMemo(
		() => getTrustChoices(parentDirectory, includeSessionOnly),
		[parentDirectory, includeSessionOnly]
	);
	const [highlightedChoice, setHighlightedChoice] = useState<
		ProjectTrustChoiceItem | undefined
	>(choices.at(0));
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
			<DialogInset>
				<box flexDirection="column" gap={1}>
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
			</DialogInset>
			<SearchListDialogWrapper<ProjectTrustChoiceItem>
				footer={
					highlightedChoice === undefined ? null : (
						<text fg={colors.textMuted} wrapMode="word">
							{highlightedChoice.description}
						</text>
					)
				}
				getKey={(choice) => choice.action}
				getSearchText={(choice) => `${choice.label} ${choice.description}`}
				items={choices}
				onHighlight={setHighlightedChoice}
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
		title: "Project Trust",
	});
	return deferred.promise;
};
