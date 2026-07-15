/**
 * Manage self-contained Veyyon profiles.
 */
import { Args, Command, Flags } from "@veyyon/pi-utils/cli";
import { type ProfileAction, type ProfileCommandArgs, runProfileCommand } from "../cli/profile-cli";

const ACTIONS: ProfileAction[] = ["list", "new", "rm"];

export default class Profile extends Command {
	static description = "List, create, or remove self-contained profiles";

	static aliases = ["profiles"];

	static args = {
		action: Args.string({
			description: "Profile action",
			required: false,
			options: ACTIONS,
			default: "list",
		}),
		name: Args.string({
			description: "Profile name (new/rm)",
			required: false,
		}),
	};

	static flags = {
		from: Flags.string({
			description: "Seed source for `new`: default, blank, or an existing profile name",
			default: "default",
		}),
		yes: Flags.boolean({ description: "Confirm profile removal", default: false }),
		json: Flags.boolean({ description: "Output JSON", default: false }),
	};

	static examples = [
		"veyyon profile list",
		"veyyon profile new work",
		"veyyon profile new bounty --from blank",
		"veyyon profile rm work --yes",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Profile);
		const cmd: ProfileCommandArgs = {
			action: (args.action ?? "list") as ProfileAction,
			name: args.name,
			from: flags.from,
			yes: flags.yes,
			json: flags.json,
		};
		try {
			await runProfileCommand(cmd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 1;
		}
	}
}
