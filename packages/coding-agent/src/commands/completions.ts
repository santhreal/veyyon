/**
 * `veyyon completions <bash|zsh|fish|powershell>` — print a shell completion script.
 *
 * The script is derived entirely from the declarative command/flag metadata
 * (see `cli/completion-gen.ts`), so it never drifts from the actual CLI surface.
 */
import { APP_ALIAS, APP_NAME, errorMessage, VERSION } from "@veyyon/utils";
import { Args, CLI_EXIT_USAGE, type CliConfig, Command, type CommandCtor, Flags } from "@veyyon/utils/cli";
import { buildSpec, generateCompletion, type Shell } from "../cli/completion-gen";
import { commands } from "../cli-commands";

/** Entry name of the default command whose flags become top-level completions. */
const ROOT_COMMAND = "launch";
const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

export default class Completions extends Command {
	static description = "Print a shell completion script (bash, zsh, fish, or powershell)";

	static args = {
		shell: Args.string({
			description: "Target shell",
			required: true,
			options: SHELLS,
		}),
	};

	static flags = {
		"no-alias": Flags.boolean({
			description: `Do not bind the '${APP_ALIAS}' launch alias (for an install where that name is someone else's)`,
			default: false,
		}),
	};

	static examples = [
		`# zsh: eval at startup, or write to a file in $fpath\n  eval "$(${APP_NAME} completions zsh)"`,
		`# bash\n  eval "$(${APP_NAME} completions bash)"`,
		`# fish\n  ${APP_NAME} completions fish > ~/.config/fish/completions/${APP_NAME}.fish`,
		`# powershell: write it beside your profile and dot-source it\n  ${APP_NAME} completions powershell > $PROFILE.d/${APP_NAME}.ps1`,
	];

	async run(): Promise<void> {
		// Parse through the declared `args`/`flags` rather than scanning argv by
		// hand. The hand-rolled scan was a second parser that disagreed with the
		// declaration it sat next to: `--no-alias=true` never matched its
		// `argv.includes("--no-alias")` test, so the alias was bound anyway, and a
		// stray trailing token was silently dropped.
		let shell: string | undefined;
		let noAlias = false;
		try {
			const parsed = await this.parse(Completions);
			shell = parsed.args.shell;
			noAlias = parsed.flags["no-alias"];
		} catch (error) {
			process.stderr.write(`Error: ${errorMessage(error)}\n`);
			process.stderr.write(`Usage: ${APP_NAME} completions <${SHELLS.join("|")}>\n`);
			process.exitCode = CLI_EXIT_USAGE;
			return;
		}
		if (!isShell(shell)) {
			// Unreachable while `options` is declared above, which is the point: the
			// narrowing below is a type guard, not a second validation.
			process.stderr.write(`Error: unsupported shell "${shell}"\n`);
			process.stderr.write(`Usage: ${APP_NAME} completions <${SHELLS.join("|")}>\n`);
			process.exitCode = CLI_EXIT_USAGE;
			return;
		}

		// Load every command class so we can read its static flag/arg descriptors,
		// and collect aliases from both the registration table and the class.
		const loaded = await Promise.all(commands.map(async entry => ({ entry, Cmd: await entry.load() })));
		const map = new Map<string, CommandCtor>();
		const aliasMap = new Map<string, readonly string[]>();
		for (const { entry, Cmd } of loaded) {
			map.set(entry.name, Cmd);
			const merged = new Set<string>([...(Cmd.aliases ?? []), ...(entry.aliases ?? [])]);
			aliasMap.set(entry.name, [...merged]);
		}

		const config: CliConfig = { bin: APP_NAME, version: VERSION, commands: map };
		// Every generated script binds the launch alias as well as the binary
		// name. An installer that declined to create `vey` (because the user
		// already had one) must also decline to complete it, or our subcommands
		// complete their tool.
		const spec = buildSpec(config, ROOT_COMMAND, aliasMap, { includeLaunchAlias: !noAlias });
		await Bun.write(Bun.stdout, generateCompletion(shell, spec));
	}
}

function isShell(value: string | undefined): value is Shell {
	return value === "bash" || value === "zsh" || value === "fish" || value === "powershell";
}
