import { errorMessage } from "@veyyon/utils";
/**
 * Manage self-contained Veyyon profiles.
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { PROFILE_ACTIONS, type ProfileAction, type ProfileCommandArgs, runProfileCommand } from "../cli/profile-cli";

export default class Profile extends Command {
	static description = "List, create, or remove self-contained profiles";

	static aliases = ["profiles"];

	static args = {
		action: Args.string({
			description: "Profile action",
			required: false,
			options: PROFILE_ACTIONS,
			default: "list",
		}),
		name: Args.string({
			description: "Profile name (new/rm/default)",
			required: false,
		}),
	};

	static flags = {
		from: Flags.string({
			description: "Seed source for `new`: default, blank, a preset (dev), or an existing profile name",
			default: "default",
		}),
		yes: Flags.boolean({ description: "Confirm profile removal", default: false }),
		clear: Flags.boolean({ description: "Clear the global defaultProfile (`default` action)", default: false }),
		json: Flags.boolean({ description: "Output JSON", default: false }),
	};

	static examples = [
		"veyyon profile list",
		"veyyon profile new work",
		"veyyon profile new dev --from dev",
		"veyyon profile new bounty --from blank",
		"veyyon profile rm work --yes",
		"veyyon profile default work",
		"veyyon profile default --clear",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Profile);
		const cmd: ProfileCommandArgs = {
			action: (args.action ?? "list") as ProfileAction,
			name: args.name,
			from: flags.from,
			yes: flags.yes,
			json: flags.json,
			clear: flags.clear,
		};
		try {
			await runProfileCommand(cmd);
		} catch (error) {
			const message = errorMessage(error);
			console.error(message);
			process.exitCode = 1;
		}
	}
}
