import { z } from "zod";
import { TOOL_RESOURCE_LIMITS } from "../resource-limits";

export const SHELL_COMMAND_MAX_CHARS =
	TOOL_RESOURCE_LIMITS.deep.shell.maxCommandChars;
export const SHELL_CWD_MAX_CHARS = TOOL_RESOURCE_LIMITS.deep.shell.maxCwdChars;
export const SHELL_TIMEOUT_DEFAULT_SECONDS =
	TOOL_RESOURCE_LIMITS.standard.shell.defaultTimeoutSeconds;
export const SHELL_TIMEOUT_MAX_SECONDS =
	TOOL_RESOURCE_LIMITS.deep.shell.maxTimeoutSeconds;
export const SHELL_OUTPUT_TAIL_BYTES =
	TOOL_RESOURCE_LIMITS.standard.shell.maxOutputBytes;

export const shellInputSchema = z.object({
	command: z.string().min(1).max(SHELL_COMMAND_MAX_CHARS),
	cwd: z.string().min(1).max(SHELL_CWD_MAX_CHARS).optional(),
	timeout: z.number().int().min(1).max(SHELL_TIMEOUT_MAX_SECONDS).optional(),
});

export const shellOutputSchema = z.object({
	exitCode: z.number().nullable(),
	output: z.string(),
	timedOut: z.boolean().optional(),
	truncated: z.boolean().optional(),
});

export type ShellInput = z.infer<typeof shellInputSchema>;
export type ShellOutput = z.infer<typeof shellOutputSchema>;

/**
 * The shell family the runner invokes on a platform. The injected platform
 * builder maps a host to one of these, and the model-facing tool description
 * is composed per family so the Agent writes the right syntax from the start.
 */
export type ShellPlatform = "posix" | "win32";

/** Maps a Node platform string to the shell family that runs on it. */
export const shellPlatformFromNode = (platform: string): ShellPlatform =>
	platform === "win32" ? "win32" : "posix";

// The permissive shell posture is recorded in ADR-0008; the model-facing copy
// below deliberately stays free of internal document references.
const SHELL_TOOL_BOUNDS_DESCRIPTION =
	"Commands are non-interactive: no stdin is provided, output keeps the final 30 KiB by default (up to 128 KiB in the deep resource profile), and the default timeout is 30 s (up to 900 s in the deep resource profile). Resource profiles are selected in Wincode configuration; elevated profiles require approval.";

/**
 * The generic catalog description used by the approval panel and the shared
 * tool registry. The model-facing description is composed per platform by
 * {@link composeShellToolDescription} so the Agent knows which syntax to write.
 */
export const shellToolDescription = `Run a bounded shell command on the user's machine. Shell runs permissively by default: harmless commands like pwd, ls, and git status execute without approval. ${SHELL_TOOL_BOUNDS_DESCRIPTION}`;

/** Composes the system-prompt tool description naming the active shell syntax. */
export const composeShellToolDescription = (platform: ShellPlatform): string =>
	platform === "win32"
		? `Run a PowerShell command on the user's machine using powershell.exe -Command (Windows PowerShell syntax). ${SHELL_TOOL_BOUNDS_DESCRIPTION}`
		: `Run a shell command on the user's machine using /bin/bash -c (macOS/Linux bash syntax). ${SHELL_TOOL_BOUNDS_DESCRIPTION}`;

export const shellToolSchema = {
	description: shellToolDescription,
	name: "shell",
	schema: shellInputSchema,
} as const;
