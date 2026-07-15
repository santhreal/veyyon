/**
 * Check for and install updates.
 */
import { Command, Flags } from "@veyyon/pi-utils/cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = "Check for and install updates";

	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.plugins) {
			process.stderr.write(
				"Bulk plugin upgrade is not available. Use `veyyon plugin install <package>` to refresh npm/git plugins.\n",
			);
			process.exit(1);
		} else {
			await updateCli.runUpdateCommand({ force: flags.force, check: flags.check });
		}
	}
}
