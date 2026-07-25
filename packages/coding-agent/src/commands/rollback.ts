/**
 * `veyyon rollback` — move the install to a specific published version.
 *
 * Three shapes, one command:
 *  - bare on a TTY: launch the interactive, searchable version picker (each row
 *    linking that version's changelog), mounted in a session-free TUI host.
 *  - `--list` (and the non-TTY fallback): print every published version.
 *  - `<version>`: non-interactive, scriptable rollback to an exact version.
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { runRollbackList, runRollbackToVersion } from "../cli/rollback-cli";
import { runRollbackPicker } from "../cli/rollback-picker";
import { initTheme } from "../modes/theme/theme";

export default class Rollback extends Command {
	static description = "Roll the install back to a previously published version";

	static args = {
		version: Args.string({
			description: "Version to roll back to (e.g. 1.0.11); omit for the interactive picker",
			required: false,
		}),
	};

	static flags = {
		list: Flags.boolean({ char: "l", description: "List every published version without rolling back" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Rollback);
		await initTheme();

		// An explicit version is scriptable and needs no TTY.
		if (args.version) {
			await runRollbackToVersion(args.version);
			return;
		}

		// `--list`, or no TTY to host the picker, prints the version list. This is
		// the deterministic, pipe-friendly path.
		const interactive = process.stdin.isTTY && process.stdout.isTTY;
		if (flags.list || !interactive) {
			await runRollbackList();
			return;
		}

		// Bare invocation on a TTY: the interactive picker, mounted in a standalone
		// TUI host outside a session.
		await runRollbackPicker();
	}
}
