/**
 * Move this install to another published version.
 */
import { Command, Flags } from "@veyyon/utils/cli";
import { defaultRollbackDeps, runRollbackCommand } from "../cli/rollback-cli";
import { pickVersion } from "../cli/rollback-picker-host";
import { openPath } from "../utils/open";

export default class Rollback extends Command {
	static description = "Move this install to another published version";

	static strict = false;

	static flags = {
		list: Flags.boolean({ description: "List every published version and exit" }),
		json: Flags.boolean({ description: "Output the version list as JSON" }),
	};

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Rollback);
		// The version is positional rather than a flag because it is the argument,
		// not an option: `veyyon rollback 1.2.3` is what a person types and what
		// goes in a bug report.
		const version = typeof argv[0] === "string" ? argv[0] : undefined;
		// The picker is offered only with a terminal on both ends. Without one the
		// command prints the list instead of opening an overlay nobody can drive.
		const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
		const result = await runRollbackCommand(
			{ list: flags.list, json: flags.json, version },
			{
				...defaultRollbackDeps(),
				pickVersion: interactive ? rows => pickVersion(rows, openPath) : undefined,
			},
		);
		if (result.exitCode !== 0) {
			process.stderr.write(`${result.output}\n`);
			process.exitCode = result.exitCode;
			return;
		}
		process.stdout.write(`${result.output}\n`);
	}
}
