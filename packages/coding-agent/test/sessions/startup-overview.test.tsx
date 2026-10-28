import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ProjectInstructionSnapshot } from "@/modules/prompt-composition/project-instructions";
import {
	ContextStartupSection,
	PluginsStartupSection,
	SkillSourceDetails,
} from "@/modules/sessions/ui/components/startup-overview";
import type { Skill } from "@/modules/skills";
import { flushTestRenderer, requireTestFrame } from "../support/opentui";

const colors = {
	primary: "white",
	secondary: "white",
	text: "white",
	textMuted: "gray",
	warning: "yellow",
};

const skill: Skill = {
	body: "",
	description: "A skill for testing startup display.",
	filePath: "/home/test/skills/long-folder-name/VeryLongSkillFile.md",
	name: "skill-name-must-not-be-rendered",
	scope: "project",
};

const plugin = {
	id: "plugin-name-must-not-be-rendered",
	sourcePath: "/home/test/plugins/plugin-directory/PluginEntry.ts",
};

test("startup skill and plugin details show paths only and wrap at path boundaries", async () => {
	const setup = await testRender(
		<box flexDirection="column" width="100%">
			<SkillSourceDetails
				colors={colors}
				homeRoot="/home/test"
				skills={[skill]}
			/>
			<PluginsStartupSection
				colors={colors}
				expanded
				homeRoot="/home/test"
				plugins={[plugin]}
			/>
		</box>,
		{ height: 16, width: 28 }
	);

	try {
		await flushTestRenderer(setup, 2);

		const frame = requireTestFrame(setup);
		const rows = frame.split("\n");
		const skillPathRows = rows.filter(
			(row) =>
				row.includes("skills/") ||
				row.includes("long-folder-name/") ||
				row.includes("VeryLongSkillFile.md")
		);
		const pluginPathRows = rows.filter(
			(row) =>
				row.includes("plugins/") ||
				row.includes("plugin-directory/") ||
				row.includes("PluginEntry.ts")
		);

		expect(skillPathRows.length).toBeGreaterThan(1);
		expect(pluginPathRows.length).toBeGreaterThan(1);
		expect(skillPathRows.some((row) => row.includes("long-folder-name/"))).toBe(
			true
		);
		expect(
			skillPathRows.some((row) => row.includes("VeryLongSkillFile.md"))
		).toBe(true);
		expect(
			pluginPathRows.some((row) => row.includes("plugin-directory/"))
		).toBe(true);
		expect(pluginPathRows.some((row) => row.includes("PluginEntry.ts"))).toBe(
			true
		);
		expect(frame).not.toContain(skill.name);
		expect(frame).not.toContain(plugin.id);
	} finally {
		await setup.renderer.destroy();
	}
});

test("startup Context details show complete AGENTS.md source paths", async () => {
	const snapshot: ProjectInstructionSnapshot = {
		diagnostics: [],
		sources: [
			{
				byteLength: 1,
				characterLength: 1,
				content: "x",
				contentHash: "hash",
				sourcePath: "AGENTS.md",
			},
			{
				byteLength: 1,
				characterLength: 1,
				content: "x",
				contentHash: "hash",
				sourcePath: "packages/AGENTS.md",
			},
		],
		totalByteLength: 2,
		workspace: "/home/test/project",
	};
	const setup = await testRender(
		<ContextStartupSection
			colors={colors}
			expanded
			homeRoot="/home/test"
			instructions={{ snapshot, status: "loaded" }}
		/>,
		{ height: 8, width: 80 }
	);

	try {
		await flushTestRenderer(setup, 2);

		const frame = requireTestFrame(setup);
		expect(frame).toContain("~/project/AGENTS.md");
		expect(frame).toContain("~/project/packages/AGENTS.md");
	} finally {
		await setup.renderer.destroy();
	}
});
