import { errorMessage } from "@veyyon/utils";
/**
 * Study a stored session: `veyyon session stats [id]`.
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { runSessionStatsCommand } from "../cli/session-stats-cli";

const SESSION_ACTIONS = ["stats"] as const;

export default class Session extends Command {
	static description = "Study a stored session (timing, tool cost, turn cadence)";

	static args = {
		action: Args.string({
			description: "Session action",
			required: false,
			options: SESSION_ACTIONS,
			default: "stats",
		}),
		id: Args.string({
			description: "Session id or filename prefix (defaults to the most recent session in this directory)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output the full report as JSON", default: false }),
	};

	static examples = ["veyyon session stats", "veyyon session stats 3f8a", "veyyon session stats --json"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Session);
		try {
			// Only `stats` exists today; the action arg keeps room for future verbs
			// without reshaping the command surface.
			await runSessionStatsCommand({ id: args.id, json: flags.json });
		} catch (error) {
			console.error(errorMessage(error));
			process.exitCode = 1;
		}
	}
}
