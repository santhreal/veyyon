/**
 * Manage configuration settings.
 */
import { Args, Command, Flags } from "@veyyon/pi-utils/cli";
import { type ConfigAction, type ConfigCommandArgs, runConfigCommand, VALID_CONFIG_ACTIONS } from "../cli/config-cli";
import { initTheme } from "../modes/theme/theme";

export default class Config extends Command {
	static description = "Manage configuration settings";

	static examples = [
		"veyyon config list",
		"veyyon config get theme",
		"veyyon config set theme catppuccin-mocha",
		"veyyon config set compaction.enabled false",
		"veyyon config reset steeringMode",
		"veyyon config list --json",
		"veyyon config init-xdg",
	];

	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: VALID_CONFIG_ACTIONS,
		}),
		key: Args.string({
			description: "Setting key",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
			},
		};

		await initTheme();
		await runConfigCommand(cmd);
	}
}
