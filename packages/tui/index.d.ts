export type StartTuiInput = {
	args: readonly string[];
	cwd: string;
};

export declare const getTuiHelpText: () => string;
export declare const startTui: (input: StartTuiInput) => Promise<number>;
