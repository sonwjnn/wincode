import * as path from "node:path";
import { TextAttributes } from "@opentui/core";
import { getErrorMessage } from "@wincode/utils";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import {
	type AgentRegistry,
	summarizeAgentDiagnostics,
} from "@/modules/agents/registry";
import { useCommandResources } from "@/modules/commands/command-resources-context";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { LoadedPluginReference } from "@/modules/plugins/runtime";
import {
	createWorkspaceProjectInstructionSnapshot,
	type ProjectInstructionSnapshot,
} from "@/modules/prompt-composition/project-instructions";
import type { Skill } from "@/modules/skills";
import { APP_VERSION } from "@/shared/app-info";
import { useConfig } from "@/shared/config/config-provider";
import { shortenHomePath } from "@/shared/paths/display-path";
import { useToggleShortcut } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	getInteractivePluginRuntime,
	getInteractiveStartupDiagnostics,
} from "@/shared/runtime-context";

type InstructionState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ snapshot: ProjectInstructionSnapshot; status: "loaded" }>
	| Readonly<{ message: string; status: "error" }>;

type StartupResourceSectionsProps = Readonly<{
	colors: StartupSectionColors;
	commandsLoading: boolean;
	customCommands: readonly CustomCommandSpec[];
	diagnostics: readonly string[];
	expanded: boolean;
	instructions: InstructionState;
	loadedPlugins: readonly LoadedPluginReference[];
	homeRoot: string;
	skills: readonly Skill[];
	skillsLoading: boolean;
}>;

let startupDetailsExpanded = false;

const collectStartupDiagnostics = (
	input: Readonly<{
		commandDiagnostics: readonly string[];
		configurationDiagnostics: readonly string[];
		instructions: InstructionState;
		pluginDiagnostics: readonly Readonly<{
			message: string;
			sourcePath: string;
		}>[];
		registry: AgentRegistry | null;
		startupDiagnostics: readonly string[];
	}>
): readonly string[] => {
	const diagnostics = [
		...input.startupDiagnostics,
		...input.pluginDiagnostics.map(
			({ message, sourcePath }) => `Plugin ${sourcePath}: ${message}`
		),
		...input.commandDiagnostics,
		...input.configurationDiagnostics,
	];
	if (input.registry !== null && input.registry.diagnostics.length > 0) {
		diagnostics.push(summarizeAgentDiagnostics(input.registry.diagnostics));
	}
	if (input.instructions.status === "loaded") {
		diagnostics.push(
			...input.instructions.snapshot.diagnostics.map(
				({ message, sourcePath }) => `${sourcePath}: ${message}`
			)
		);
	} else if (input.instructions.status === "error") {
		diagnostics.push(input.instructions.message);
	}
	return diagnostics;
};

export function StartupOverview() {
	const config = useConfig();
	const { colors } = useTheme();
	const registry = useAgentRegistry();
	const {
		commandsLoading,
		customCommands,
		diagnostics: commandDiagnostics,
		skills,
		skillsLoading,
	} = useCommandResources();
	const pluginRuntime = getInteractivePluginRuntime();
	const loadedPlugins = pluginRuntime?.getLoadedPlugins() ?? [];
	const [instructions, setInstructions] = useState<InstructionState>({
		status: "loading",
	});
	const [configurationDiagnostics, setConfigurationDiagnostics] = useState<
		readonly string[]
	>([]);
	const [isExpanded, setIsExpanded] = useState(startupDetailsExpanded);

	useEffect(() => {
		let active = true;
		setInstructions({ status: "loading" });
		setConfigurationDiagnostics([]);
		void Promise.all([
			createWorkspaceProjectInstructionSnapshot({
				cwd: config.cwd,
				workspace: config.workspace,
			}),
			config.configStore.getSnapshot(config.workspace),
		])
			.then(([snapshot, configSnapshot]) => {
				if (!active) {
					return;
				}
				setInstructions({ snapshot, status: "loaded" });
				setConfigurationDiagnostics(
					configSnapshot.diagnostics.map(
						({ message, path }) => `${path}: ${message}`
					)
				);
			})
			.catch((error: unknown) => {
				if (!active) {
					return;
				}
				setInstructions({
					message: getErrorMessage(
						error,
						"Could not inspect startup resources."
					),
					status: "error",
				});
			});
		return () => {
			active = false;
		};
	}, [config.configStore, config.cwd, config.workspace]);

	const toggleExpanded = useCallback(() => {
		setIsExpanded((current) => {
			startupDetailsExpanded = !current;
			return !current;
		});
	}, []);
	useToggleShortcut("ctrl+o", toggleExpanded);

	const diagnostics = collectStartupDiagnostics({
		commandDiagnostics,
		configurationDiagnostics,
		instructions,
		pluginDiagnostics: pluginRuntime?.diagnostics ?? [],
		registry,
		startupDiagnostics: getInteractiveStartupDiagnostics(),
	});

	return (
		<box flexDirection="column" gap={1} width="100%">
			<StartupHelp
				colors={colors}
				expanded={isExpanded}
				onToggleExpanded={toggleExpanded}
			/>
			<StartupResourceSections
				colors={colors}
				commandsLoading={commandsLoading}
				customCommands={customCommands}
				diagnostics={diagnostics}
				expanded={isExpanded}
				homeRoot={config.homeRoot}
				instructions={instructions}
				loadedPlugins={loadedPlugins}
				skills={skills}
				skillsLoading={skillsLoading}
			/>
		</box>
	);
}

function StartupHelp({
	colors,
	expanded,
	onToggleExpanded,
}: Readonly<{
	colors: StartupSectionColors;
	expanded: boolean;
	onToggleExpanded: () => void;
}>) {
	return (
		<box flexDirection="column" width="100%">
			<box flexDirection="row" gap={1} width="100%">
				<text attributes={TextAttributes.BOLD} fg={colors.primary}>
					Wincode
				</text>
				<text fg={colors.textMuted}>v{APP_VERSION}</text>
				{expanded ? null : (
					<text fg={colors.textMuted}>
						Enter send · Shift+Enter newline · / commands · @ files · Ctrl+O
						more
					</text>
				)}
			</box>
			{expanded ? (
				<box flexDirection="column" width="100%">
					<text fg={colors.textMuted}>Enter to send</text>
					<text fg={colors.textMuted}>Shift+Enter to insert a newline</text>
					<text fg={colors.textMuted}>/ to browse commands</text>
					<text fg={colors.textMuted}>@ to mention files</text>
					<StartupTogglePrompt
						color={colors.textMuted}
						label="Ctrl+O to collapse startup help and resources"
						onToggle={onToggleExpanded}
					/>
				</box>
			) : (
				<StartupTogglePrompt
					color={colors.textMuted}
					label="Click or press Ctrl+O to show full startup help and loaded resources."
					onToggle={onToggleExpanded}
				/>
			)}
		</box>
	);
}

function StartupTogglePrompt({
	color,
	label,
	onToggle,
}: Readonly<{ color: string; label: string; onToggle: () => void }>) {
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI has no button primitive; this visible row is a mouse toggle. */}
			<box onMouseDown={onToggle} width="100%">
				<text fg={color}>{label}</text>
			</box>
		</>
	);
}

function StartupResourceSections({
	colors,
	commandsLoading,
	customCommands,
	diagnostics,
	expanded,
	homeRoot,
	instructions,
	loadedPlugins,
	skills,
	skillsLoading,
}: StartupResourceSectionsProps) {
	return (
		<box flexDirection="column" gap={1} width="100%">
			<ContextStartupSection
				colors={colors}
				expanded={expanded}
				homeRoot={homeRoot}
				instructions={instructions}
			/>
			<SkillsStartupSection
				colors={colors}
				expanded={expanded}
				homeRoot={homeRoot}
				skills={skills}
				skillsLoading={skillsLoading}
			/>
			<CommandsStartupSection
				colors={colors}
				commands={customCommands}
				expanded={expanded}
				isLoading={commandsLoading}
			/>
			<PluginsStartupSection
				colors={colors}
				expanded={expanded}
				homeRoot={homeRoot}
				plugins={loadedPlugins}
			/>
			<DiagnosticsStartupSection
				colors={colors}
				diagnostics={diagnostics}
				expanded={expanded}
			/>
		</box>
	);
}

type StartupSectionColors = Readonly<{
	primary: string;
	secondary: string;
	text: string;
	textMuted: string;
	warning: string;
}>;

function ContextStartupSection({
	colors,
	expanded,
	homeRoot,
	instructions,
}: Readonly<{
	colors: StartupSectionColors;
	expanded: boolean;
	homeRoot: string;
	instructions: InstructionState;
}>) {
	if (instructions.status === "loading") {
		return (
			<StartupSection color={colors.primary} title="Context">
				<text fg={colors.textMuted} paddingLeft={expanded ? 2 : 0}>
					Loading…
				</text>
			</StartupSection>
		);
	}
	if (
		instructions.status === "error" ||
		instructions.snapshot.sources.length === 0
	) {
		return null;
	}
	const sources = instructions.snapshot.sources;
	return (
		<StartupSection color={colors.primary} title="Context">
			{expanded ? (
				sources.map(({ sourcePath }) => (
					<text
						fg={colors.textMuted}
						key={sourcePath}
						paddingLeft={2}
						wrapMode="word"
					>
						{shortenHomePath(sourcePath, homeRoot)}
					</text>
				))
			) : (
				<CompactNameList
					color={colors.textMuted}
					items={sources.map(({ sourcePath }) => ({
						key: sourcePath,
						name: path.basename(sourcePath),
					}))}
				/>
			)}
		</StartupSection>
	);
}

function SkillsStartupSection({
	colors,
	expanded,
	homeRoot,
	skills,
	skillsLoading,
}: Readonly<{
	colors: StartupSectionColors;
	expanded: boolean;
	homeRoot: string;
	skills: readonly Skill[];
	skillsLoading: boolean;
}>) {
	if (skillsLoading) {
		return (
			<StartupSection color={colors.primary} title="Skills">
				<text fg={colors.textMuted} paddingLeft={expanded ? 2 : 0}>
					Loading…
				</text>
			</StartupSection>
		);
	}
	if (skills.length === 0) {
		return null;
	}
	return (
		<StartupSection color={colors.primary} title="Skills">
			{expanded ? (
				<SkillSourceDetails
					colors={colors}
					homeRoot={homeRoot}
					skills={skills}
				/>
			) : (
				<CompactNameList
					color={colors.textMuted}
					items={skills.map(({ filePath, name }) => ({
						key: filePath,
						name,
					}))}
				/>
			)}
		</StartupSection>
	);
}

function SkillSourceDetails({
	colors,
	homeRoot,
	skills,
}: Readonly<{
	colors: StartupSectionColors;
	homeRoot: string;
	skills: readonly Skill[];
}>) {
	return (
		<box flexDirection="column" width="100%">
			{(["project", "global"] as const).map((scope) => {
				const scopedSkills = skills.filter((skill) => skill.scope === scope);
				if (scopedSkills.length === 0) {
					return null;
				}
				return (
					<box flexDirection="column" key={scope} paddingLeft={2} width="100%">
						<text fg={colors.secondary}>
							{scope === "global" ? "User" : "Project"}
						</text>
						{scopedSkills.map(({ filePath, name }) => (
							<box
								flexDirection="row"
								key={filePath}
								paddingLeft={2}
								width="100%"
							>
								<text fg={colors.text} flexShrink={0} wrapMode="none">
									{name}
								</text>
								<text
									fg={colors.textMuted}
									flexGrow={1}
									flexShrink={1}
									wrapMode="word"
								>
									· {shortenHomePath(filePath, homeRoot)}
								</text>
							</box>
						))}
					</box>
				);
			})}
		</box>
	);
}

function CommandsStartupSection({
	colors,
	commands,
	expanded,
	isLoading,
}: Readonly<{
	colors: StartupSectionColors;
	commands: readonly CustomCommandSpec[];
	expanded: boolean;
	isLoading: boolean;
}>) {
	if (isLoading) {
		return (
			<StartupSection color={colors.primary} title="Prompts">
				<text fg={colors.textMuted} paddingLeft={expanded ? 2 : 0}>
					Loading…
				</text>
			</StartupSection>
		);
	}
	if (commands.length === 0) {
		return null;
	}
	return (
		<StartupSection color={colors.primary} title="Prompts">
			{expanded ? (
				commands.map(({ description, name }) => (
					<box flexDirection="row" key={name} paddingLeft={2} width="100%">
						<text fg={colors.secondary} flexShrink={0} wrapMode="none">
							/{name}
						</text>
						<text
							fg={colors.textMuted}
							flexGrow={1}
							flexShrink={1}
							wrapMode="word"
						>
							— {description}
						</text>
					</box>
				))
			) : (
				<CompactNameList
					color={colors.textMuted}
					items={commands.map(({ name }) => ({
						key: name,
						name: `/${name}`,
					}))}
				/>
			)}
		</StartupSection>
	);
}

function PluginsStartupSection({
	colors,
	expanded,
	homeRoot,
	plugins,
}: Readonly<{
	colors: StartupSectionColors;
	expanded: boolean;
	homeRoot: string;
	plugins: readonly LoadedPluginReference[];
}>) {
	if (plugins.length === 0) {
		return null;
	}
	return (
		<StartupSection color={colors.primary} title="Plugins">
			{expanded ? (
				plugins.map(({ id, sourcePath }) => (
					<box
						flexDirection="row"
						id={`startup-plugin-${id}`}
						key={id}
						paddingLeft={2}
						width="100%"
					>
						<text fg={colors.text} flexShrink={0} wrapMode="none">
							{id}
						</text>
						<text
							fg={colors.textMuted}
							flexGrow={1}
							flexShrink={1}
							wrapMode="word"
						>
							· {shortenHomePath(sourcePath, homeRoot)}
						</text>
					</box>
				))
			) : (
				<CompactNameList
					color={colors.textMuted}
					items={plugins.map(({ id }) => ({ key: id, name: id }))}
				/>
			)}
		</StartupSection>
	);
}

function DiagnosticsStartupSection({
	colors,
	diagnostics,
	expanded,
}: Readonly<{
	colors: StartupSectionColors;
	diagnostics: readonly string[];
	expanded: boolean;
}>) {
	if (!expanded || diagnostics.length === 0) {
		return null;
	}
	return (
		<StartupSection color={colors.warning} title="Startup diagnostics">
			{diagnostics.map((message) => (
				<text fg={colors.warning} key={message} paddingLeft={2}>
					{message}
				</text>
			))}
		</StartupSection>
	);
}

type CompactNameListProps = Readonly<{
	color: string;
	items: readonly Readonly<{ key: string; name: string }>[];
}>;

export function CompactNameList({ color, items }: CompactNameListProps) {
	return (
		<box flexDirection="row" flexWrap="wrap" width="100%">
			{items.map(({ key, name }, index) => (
				<box
					flexDirection="row"
					flexShrink={0}
					key={key}
					paddingLeft={index === 0 ? 1 : 0}
				>
					<text fg={color} flexShrink={0} wrapMode="none">
						{index === items.length - 1 ? name : `${name}, `}
					</text>
				</box>
			))}
		</box>
	);
}

type StartupSectionProps = Readonly<{
	children: ReactNode;
	color: string;
	title: string;
}>;

function StartupSection({ children, color, title }: StartupSectionProps) {
	return (
		<box flexDirection="column" gap={0} width="100%">
			<text attributes={TextAttributes.BOLD} fg={color}>
				[{title}]
			</text>
			{children}
		</box>
	);
}
