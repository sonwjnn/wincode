#!/usr/bin/env bun

import { dispatch } from "./dispatch";

const stdout = {
	write: (text: string): void => {
		process.stdout.write(text);
	},
};
const stderr = {
	write: (text: string): void => {
		process.stderr.write(text);
	},
};

process.exitCode = await dispatch({
	args: process.argv.slice(2),
	cwd: process.cwd(),
	stderr,
	stdout,
});
