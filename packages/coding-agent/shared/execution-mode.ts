export const EXECUTION_MODES = ["interactive", "print", "json", "rpc"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
