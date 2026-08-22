/**
 * Decide whether the code in this project may run.
 */
import { getAgentDir } from "@veyyon/utils";
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { renderTrustReport, runTrustCommand, type TrustAction } from "../cli/trust-cli";
import { clearClaudePluginRootsCache } from "../discovery/helpers";

export default class Trust extends Command {
	static description = "Approve, refuse or review the project code veyyon is allowed to load";

	static strict = false;

	static args = {
		path: Args.string({ description: "File to decide about (defaults to everything discovered)" }),
	};

	static flags = {
		deny: Flags.boolean({ description: "Refuse this project, and remember the refusal" }),
		forget: Flags.boolean({ description: "Drop this project's decision so it is asked again" }),
		list: Flags.boolean({ description: "Show the decision without changing it" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Trust);
		const chosen: TrustAction[] = [];
		if (flags.deny) chosen.push("deny");
		if (flags.forget) chosen.push("forget");
		if (flags.list) chosen.push("list");
		if (chosen.length > 1) {
			process.stderr.write(`Pick one of --deny, --forget, --list.\n`);
			process.exitCode = 1;
			return;
		}

		const result = await runTrustCommand({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			action: chosen[0] ?? "approve",
			paths: argv.filter((value): value is string => typeof value === "string"),
		});
		// A decision changes what discovery is allowed to read, and plugin roots are cached per
		// process. Harmless here (the command exits) and required when this logic is reached from a
		// live session.
		clearClaudePluginRootsCache();

		process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : renderTrustReport(result));
		if (result.unreadable.length > 0) process.exitCode = 1;
	}
}
