/**
 * Command-line input error that is rendered without a stack trace: a missing or invalid positional
 * or flag. A top-level handler prints its message plus the usage line and exits with the usage
 * code, instead of letting it reach the process-level catch that dumps a code frame over a plain
 * argument mistake (issue #5369). A leaf so the CLI entry catches it without loading the command
 * framework in `./cli`.
 */
export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}
