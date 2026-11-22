import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "../..");
const workspace = process.argv[2];
if (!(workspace && path.isAbsolute(workspace))) {
	throw new Error(
		"Expected the absolute path of the isolated smoke workspace."
	);
}

const artifacts = path.join(path.dirname(workspace), "packages");
await fs.mkdir(artifacts, { recursive: true });
const overrides: Record<string, string> = {};
type PackedManifest = {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};
const packed = new Map<string, PackedManifest>();
const published = process.argv.includes("--published");
for (const pkg of published
	? []
	: ["agent-core", "ai", "coding-agent", "mcp", "subagents", "tui", "utils"]) {
	const tarball = (
		await $`${process.execPath} pm pack --destination ${artifacts} --ignore-scripts --quiet`
			.cwd(path.join(root, "packages", pkg))
			.text()
	).trim();
	const manifest: PackedManifest = JSON.parse(
		await $`tar -xOzf ${tarball} package/package.json`.text()
	);
	packed.set(manifest.name, manifest);
	overrides[manifest.name] = `file:${tarball}`;
}
for (const manifest of packed.values()) {
	for (const [name, range] of Object.entries({
		...manifest.dependencies,
		...manifest.peerDependencies,
	})) {
		const target = packed.get(name);
		if (
			range.startsWith("workspace:") ||
			range.startsWith("catalog:") ||
			(name.startsWith("@wincode/") &&
				!(target && Bun.semver.satisfies(target.version, range)))
		) {
			throw new Error(
				`${manifest.name} cannot resolve packed dependency ${name}@${range}.`
			);
		}
	}
}

const fixture = path.join(workspace, ".wincode/plugins/external-smoke");
const manifest = await Bun.file(
	path.join(root, "packages/coding-agent/package.json")
).json();
const tui = await Bun.file(path.join(root, "packages/tui/package.json")).json();
const repo = await Bun.file(path.join(root, "package.json")).json();
const { react, typescript, zod } = repo.workspaces.catalog;
await Bun.write(
	path.join(workspace, "package.json"),
	JSON.stringify({
		name: "packed-wincode-consumer",
		private: true,
		workspaces: [".wincode/plugins/external-smoke"],
		dependencies: { "@wincode/coding-agent": manifest.version },
		devDependencies: {
			"@types/bun": repo.workspaces.catalog["@types/bun"],
			"@types/react": manifest.devDependencies["@types/react"],
			"@wincode/ai": manifest.version,
			typescript,
			zod,
		},
		overrides,
	})
);
await Bun.write(
	path.join(fixture, "package.json"),
	JSON.stringify({
		name: "independent-wincode-smoke-plugin",
		private: true,
		dependencies: { zod },
		peerDependencies: {
			"@wincode/coding-agent": manifest.version,
			"@wincode/tui": tui.version,
			react,
		},
		scripts: { "check-types": "tsc --noEmit" },
	})
);
await Bun.write(
	path.join(fixture, "tsconfig.json"),
	JSON.stringify({
		compilerOptions: {
			allowImportingTsExtensions: true,
			jsx: "react-jsx",
			jsxImportSource: "@wincode/tui",
			module: "ESNext",
			moduleResolution: "Bundler",
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			target: "ESNext",
			types: ["bun"],
		},
		include: ["*.ts", "*.tsx"],
	})
);
const support = path.join(root, "packages/coding-agent/test/support");
await fs.copyFile(
	path.join(support, "interactive-smoke-provider.ts"),
	path.join(workspace, "interactive-smoke-provider.ts")
);
await fs.copyFile(
	path.join(support, "interactive-plugin-ui-smoke.tsx"),
	path.join(fixture, "interactive-plugin-ui-smoke.tsx")
);
await $`git init --quiet`.cwd(fixture);
await $`${process.execPath} install`.cwd(workspace);
await $`${process.execPath} run check-types`.cwd(fixture);
const cli = path.join(workspace, "node_modules/.bin/wincode");
const installedVersion = (
	await $`${cli} --version`.cwd(workspace).text()
).trim();
if (installedVersion !== manifest.version) {
	throw new Error(
		`Expected installed Wincode ${manifest.version}, got ${installedVersion}.`
	);
}

const runRpc = (...options: string[]) =>
	$`${cli} --mode rpc ${options} < /dev/null`.cwd(workspace).quiet();
const probe = path.join(fixture, "probe.ts");
const marker = Bun.file(path.join(workspace, "probe-loaded"));
const config = path.join(workspace, ".wincode/settings.json");
const settings = await Bun.file(config).text();
await Bun.write(
	probe,
	`
import type { PluginFactory } from "@wincode/coding-agent";
const probe: PluginFactory = async (api, { workspace }) => {
	api.definePlugin({ id: "external_probe" });
	await Bun.write(workspace + "/probe-loaded", "loaded");
};
export default probe;
`
);
try {
	await runRpc("--trust-project");
	if (await marker.exists()) {
		throw new Error("A Plugin ran merely because it was present.");
	}
	await Bun.write(
		config,
		JSON.stringify({
			...JSON.parse(settings),
			plugins: ["./plugins/external-smoke/probe.ts"],
		})
	);
	await runRpc("--no-trust-project");
	if (await marker.exists()) {
		throw new Error("A Plugin ran through untrusted project config.");
	}
	await runRpc("--trust-project");
	if (!(await marker.exists())) {
		throw new Error("Trusted config did not enable the Plugin.");
	}
	await marker.delete();
	await Bun.write(config, settings);
	const missing = path.join(fixture, "missing.ts");
	await runRpc("--plugin", missing, "--plugin", probe);
	const logDir = path.join(path.dirname(workspace), ".wincode/logs");
	let diagnosed = false;
	for (const log of await fs.readdir(logDir)) {
		const contents = await Bun.file(path.join(logDir, log)).text();
		diagnosed ||= contents
			.split("\n")
			.some(
				(line) =>
					line.includes("Could not load Plugin") && line.includes(missing)
			);
	}
	if (!diagnosed) {
		throw new Error("A failed Plugin load did not produce a diagnostic.");
	}
	if (!(await marker.exists())) {
		throw new Error(
			"A bad Plugin prevented explicit loading of a valid Plugin."
		);
	}
} finally {
	await Bun.write(config, settings);
}
