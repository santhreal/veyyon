import { Command } from "@veyyon/utils/cli";
import licenseBundle from "../../../../THIRD_PARTY_LICENSES.txt" with { type: "text" };

export default class Licenses extends Command {
	static description = "Print Veyyon and third-party license notices";

	async run(): Promise<void> {
		process.stdout.write(licenseBundle);
	}
}
