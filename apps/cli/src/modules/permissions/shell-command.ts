import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * Normalizes a command for policy identity: lowercase, quotes removed, and
 * whitespace collapsed, so `RM -rf "/"` and `rm -rf  "/"` match the same
 * exact-command grant.
 */
export const normalizeShellCommand = (command: string): string =>
	command.toLowerCase().replace(/['"`]/g, "").replace(/\s+/g, " ").trim();

/**
 * The command names that skip the shell ask entirely (ADR-0008): the bash
 * family plus the PowerShell aliases, so an Agent can navigate the workspace
 * without prompting. A `cwd` outside the workspace still composes the
 * `external_directory` ask on the call.
 */
export const CD_FAMILY_COMMANDS: Readonly<Record<string, true>> = {
	cd: true,
	chdir: true,
	popd: true,
	"push-location": true,
	pushd: true,
	"set-location": true,
};

export const isCdFamilyCommand = (command: string): boolean =>
	CD_FAMILY_COMMANDS[command.toLowerCase()] === true;

/**
 * One evaluated shell command node: the command name (for the cd exemption)
 * and the node's own text, which is the resource matched against the shell
 * policy rules.
 */
export type ShellCommandNode = {
	command: string;
	text: string;
};

const FIRST_TOKEN_SPLIT = /\s+/;

const resolveModuleFile = (specifier: string): string =>
	fileURLToPath(import.meta.resolve(specifier));

const BASE_WASM_PATH = resolveModuleFile("web-tree-sitter/tree-sitter.wasm");
const BASH_WASM_PATH = resolveModuleFile(
	"tree-sitter-wasms/out/tree-sitter-bash.wasm"
);
const POWERSHELL_WASM_PATH = resolveModuleFile(
	"tree-sitter-powershell/tree-sitter-powershell.wasm"
);

type ShellGrammars = {
	bash: Language;
	powershell: Language;
};

let grammarPromise: Promise<ShellGrammars> | undefined;
let bashParser: Parser | undefined;
let powershellParser: Parser | undefined;

/**
 * Loads the bash and powershell tree-sitter grammars once per process. The
 * first shell call pays the wasm load; later calls reuse the compiled
 * languages and parsers.
 */
const loadShellGrammars = async (): Promise<ShellGrammars> => {
	grammarPromise ??= (async () => {
		await Parser.init({ locateFile: () => BASE_WASM_PATH });
		const [bash, powershell] = await Promise.all([
			Language.load(BASH_WASM_PATH),
			Language.load(POWERSHELL_WASM_PATH),
		]);
		return { bash, powershell };
	})();
	return grammarPromise;
};

const getParsers = async (): Promise<{
	bash: Parser;
	powershell: Parser;
}> => {
	const grammars = await loadShellGrammars();
	if (bashParser === undefined) {
		bashParser = new Parser();
		bashParser.setLanguage(grammars.bash);
	}
	if (powershellParser === undefined) {
		powershellParser = new Parser();
		powershellParser.setLanguage(grammars.powershell);
	}
	return { bash: bashParser, powershell: powershellParser };
};

const commandNameOf = (node: Node): string => {
	for (const child of node.namedChildren) {
		if (child?.type === "command_name") {
			return child.text.trim();
		}
	}
	const first = node.text.trim().split(FIRST_TOKEN_SPLIT)[0];
	return first ?? "";
};

const collectCommandNodes = (root: Node): ShellCommandNode[] => {
	const nodes: ShellCommandNode[] = [];
	const walk = (node: Node): void => {
		if (node.type === "command") {
			const text = node.text.trim();
			if (text !== "") {
				nodes.push({ command: commandNameOf(node), text });
			}
		}
		for (const child of node.namedChildren) {
			if (child !== null) {
				walk(child);
			}
		}
	};
	walk(root);
	return nodes;
};

/**
 * Parses a shell command with the tree-sitter grammars and returns every
 * command node (simple commands inside compound statements, pipelines, and
 * redirects) as its own evaluable resource. The platform's own grammar parses
 * first and the other grammar backs it up; when both produce a syntax-error
 * tree the command is unparseable and `undefined` is returned so the caller
 * fails closed to an ask.
 */
export const parseShellCommandNodes = async (
	command: string
): Promise<ShellCommandNode[] | undefined> => {
	const { bash, powershell } = await getParsers();
	const preferred = process.platform === "win32" ? powershell : bash;
	const fallback = preferred === bash ? powershell : bash;
	for (const parser of [preferred, fallback]) {
		const tree = parser.parse(command);
		if (tree === null || tree.rootNode.hasError) {
			continue;
		}
		return collectCommandNodes(tree.rootNode);
	}
};
