import { createContext, useContext } from "react";
import type { Skill } from "@/modules/skills";
import type { CustomCommandSpec } from "./custom/types";

export type CommandResourceState = Readonly<{
	customCommands: readonly CustomCommandSpec[];
	skills: readonly Skill[];
	commandsLoading: boolean;
	skillsLoading: boolean;
	diagnostics: readonly string[];
}>;

export const CommandResourcesContext = createContext<CommandResourceState>({
	customCommands: [],
	skills: [],
	commandsLoading: true,
	skillsLoading: true,
	diagnostics: [],
});

export const useCommandResources = (): CommandResourceState =>
	useContext(CommandResourcesContext);
