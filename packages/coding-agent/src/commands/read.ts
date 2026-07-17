/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */
import { Args, Command } from "@veyyon/pi-utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path, URL, or internal URI";

	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		"veyyon read src/foo.ts",
		"veyyon read src/foo.ts:50-100",
		"veyyon read src/foo.ts:raw",
		"veyyon read https://example.com",
		"veyyon read veyyon://",
		"veyyon read issue://123",
		"veyyon read path/to/archive.zip:dir/file.ts",
		"veyyon read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
