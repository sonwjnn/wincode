/**
 * The model-visible reason attached to a destructive shell approval: the panel
 * renders it instead of the malformed-config safety banner, and it makes clear
 * why the always/remember option is absent.
 */
export const DESTRUCTIVE_SHELL_SAFETY_MESSAGE =
	"Destructive command: requires explicit approval every time and can never be auto-approved or remembered.";

/**
 * Normalizes a command for classification: lowercase, quotes removed, and
 * whitespace collapsed, so `RM -RF "/"` and `rm -rf  "/"` classify the same.
 */
export const normalizeShellCommand = (command: string): string =>
	command.toLowerCase().replace(/['"`]/g, "").replace(/\s+/g, " ").trim();

/**
 * Root-level `rm -rf` targets: the filesystem root, a root glob, the current
 * directory's full contents, the home directory, and `$HOME`.
 */
const ROOT_RM_TARGET_REGEX =
	/^(?:\*|~(?:\/|\*)*|\$home(?:\/|\*)*|\/(?:\*)?|\.{1,2}(?:\/|\*)*)$/;

/** Fork bombs in their classic `:(){ :|:& };:` family. */
const FORK_BOMB_REGEX = /[:a-z_][:a-z0-9_]*\(\s*\)\s*\{[^{}]*\|:&[^{}]*\};/;

/** `curl ... | sh` and `wget ... | sh` pipelines (optionally through sudo). */
const PIPE_TO_SHELL_REGEX =
	/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/;

/** `dd` writing to a block device, excluding the safe `/dev/null` family. */
const DD_TO_BLOCK_DEVICE_REGEX =
	/\bdd\b[^\n|;&]*\bof=\/dev\/(?!null\b|zero\b|urandom\b|random\b)/;

const FIRST_TOKEN_DESTRUCTIVE_REGEX =
	/^(?:mkfs(?:\.[a-z0-9]+)?|fdisk|diskutil|shutdown|reboot|poweroff|halt)$/;

const ANY_SUDO_REGEX = /\bsudo\b/;

/**
 * Classifies a shell command as destructive. The classifier is a safety
 * ceiling, not a sandbox: it normalizes case, whitespace, and quoting, then
 * matches the seven destructive pattern groups — root-level `rm -rf`, `sudo`,
 * `curl|sh`/`wget|sh` pipelines, `dd` to block devices,
 * `mkfs`/`fdisk`/`diskutil`, `shutdown`/`reboot`, and fork bombs. A match
 * forces a manual approval that neither grants nor `--auto` can bypass.
 */
export const isDestructiveShellCommand = (command: string): boolean => {
	const normalized = normalizeShellCommand(command);
	if (normalized === "") {
		return false;
	}
	if (ANY_SUDO_REGEX.test(normalized)) {
		return true;
	}
	if (PIPE_TO_SHELL_REGEX.test(normalized)) {
		return true;
	}
	if (DD_TO_BLOCK_DEVICE_REGEX.test(normalized)) {
		return true;
	}
	if (FORK_BOMB_REGEX.test(normalized)) {
		return true;
	}
	const tokens = normalized.split(" ");
	if (tokens[0] === undefined) {
		return false;
	}
	if (FIRST_TOKEN_DESTRUCTIVE_REGEX.test(tokens[0])) {
		return true;
	}
	if (tokens[0] !== "rm") {
		return false;
	}
	const flags = tokens.slice(1).filter((token) => token.startsWith("-"));
	const targets = tokens.slice(1).filter((token) => !token.startsWith("-"));
	const hasRecursiveFlag = flags.some((flag) => flag.includes("r"));
	const hasForceFlag = flags.some((flag) => flag.includes("f"));
	return (
		hasRecursiveFlag &&
		hasForceFlag &&
		targets.some((target) => ROOT_RM_TARGET_REGEX.test(target))
	);
};
