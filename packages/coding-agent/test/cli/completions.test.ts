import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join as pathJoin } from "node:path";
import { buildSpec, type CompletionSpec, generateCompletion } from "@veyyon/coding-agent/cli/completion-gen";
import { APP_ALIAS } from "@veyyon/utils";
import type { CliConfig, CommandCtor } from "@veyyon/utils/cli";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

// A compact synthetic spec exercising every value-source kind and an aliased
// subcommand. The generators are pure functions of this shape, so pinning their
// output here defends the exact bytes each shell parses without booting the CLI.
const spec: CompletionSpec = {
	bin: "veyyon",
	binAliases: ["vey"],
	root: {
		flags: [
			{ name: "model", description: "Model to use", value: { kind: "models", multiple: false }, repeatable: false },
			{ name: "models", description: "Model list", value: { kind: "models", multiple: true }, repeatable: false },
			{
				name: "thinking",
				description: "Effort",
				value: { kind: "enum", values: ["low", "high"] },
				repeatable: false,
			},
			{ name: "tools", description: "Tools", value: { kind: "list", values: ["read", "bash"] }, repeatable: false },
			{ name: "resume", char: "r", description: "Resume", value: { kind: "sessions" }, repeatable: false },
			{ name: "print", char: "p", description: "Print", value: { kind: "flag" }, repeatable: false },
			{ name: "extension", char: "e", description: "Ext", value: { kind: "file" }, repeatable: true },
			{ name: "session-dir", description: "Dir", value: { kind: "dir" }, repeatable: false },
		],
		args: [],
	},
	commands: [
		{
			name: "commit",
			aliases: [],
			description: "Commit",
			flags: [{ name: "push", description: "Push", value: { kind: "flag" }, repeatable: false }],
			args: [],
		},
		{
			name: "worktree",
			aliases: ["wt"],
			description: "Worktrees",
			flags: [],
			args: [{ name: "action", description: "Action", value: { kind: "enum", values: ["list", "clear"] } }],
		},
	],
};

/**
 * The `vey` alias must complete exactly like `veyyon`.
 *
 * Why this suite exists: both installers link `vey` next to the binary and every
 * doc and in-app tip tells users to launch with it, but the generators bound
 * completions to `spec.bin` alone. Tab completion therefore worked only for the
 * name almost nobody types, and the documented entry point silently offered
 * nothing in all three shells. Each shell needs a different binding mechanism, so
 * each is asserted separately rather than through one shared substring check.
 */
describe("generated completions bind the launch alias, not just the binary name", () => {
	it("bash registers the dispatcher for the binary AND the alias in one complete call", () => {
		// bash binds by command name; `complete -F` accepts several names at once,
		// so one generated file serves both once the file itself is loaded.
		expect(generateCompletion("bash", spec)).toContain("complete -F _veyyon veyyon vey");
	});

	it("zsh names both commands on #compdef so one autoloaded file serves both", () => {
		// compinit reads `#compdef` from the file in $fpath and binds every name it
		// lists — this is what makes a second `_vey` file unnecessary.
		const out = generateCompletion("zsh", spec);
		expect(out.split("\n")[0]).toBe("#compdef veyyon vey");
	});

	it("zsh also passes both names to compdef on the sourced/eval'd path", () => {
		// The generated script works two ways (autoloaded or eval'd from a startup
		// file). The eval'd branch registers with `compdef`, and it must bind the
		// alias too or `eval "$(veyyon completions zsh)"` regresses to binary-only.
		expect(generateCompletion("zsh", spec)).toContain("compdef _veyyon veyyon vey");
	});

	it("fish wraps the alias onto the binary instead of re-emitting every rule", () => {
		// fish has no multi-name binding, so the alias reuses all ~800 rules via
		// `-w` (wraps). Re-emitting them under a second name would double the file
		// and let the two copies drift.
		const out = generateCompletion("fish", spec);
		expect(out).toContain("complete -c vey -w veyyon");
		// The wrap is the ONLY alias-specific line: no duplicated rule set.
		const veyRules = out.split("\n").filter(l => l.startsWith("complete -c vey "));
		expect(veyRules).toEqual(["complete -c vey -w veyyon"]);
	});

	it("emits no alias binding when the spec declares none", () => {
		// A consumer building a spec without aliases must get clean single-command
		// output, not a stray empty name in `complete -F _veyyon veyyon `.
		const solo: CompletionSpec = { ...spec, binAliases: [] };
		expect(generateCompletion("bash", solo)).toContain("complete -F _veyyon veyyon\n");
		expect(generateCompletion("zsh", solo).split("\n")[0]).toBe("#compdef veyyon");
		// Matched on the word boundary, not a substring: `complete -c veyyon ...`
		// also starts with "complete -c vey".
		expect(
			generateCompletion("fish", solo)
				.split("\n")
				.filter(l => l.startsWith("complete -c vey ")),
		).toEqual([]);
	});

	it("ignores an alias that merely repeats the binary name", () => {
		// Guards the degenerate config: `complete -F _veyyon veyyon veyyon` is not a
		// hard error in bash but it is nonsense, and `#compdef veyyon veyyon` makes
		// compinit warn about a duplicate binding.
		const dup: CompletionSpec = { ...spec, binAliases: ["veyyon"] };
		expect(generateCompletion("bash", dup)).toContain("complete -F _veyyon veyyon\n");
		expect(generateCompletion("zsh", dup).split("\n")[0]).toBe("#compdef veyyon");
	});
});

describe("generateCompletion — bash", () => {
	const out = generateCompletion("bash", spec);

	it("registers the dispatcher and resolves alias arms to the canonical handler", () => {
		expect(out).toContain("complete -F _veyyon veyyon");
		expect(out).toContain("_veyyon_cmd_commit");
		// worktree + its alias dispatch to the same function
		expect(out).toContain("worktree|wt)");
	});

	it("completes enum, dynamic, and comma-list flag values by previous flag", () => {
		expect(out).toContain('--thinking)\n\t\t\tCOMPREPLY=( $(compgen -W "low high"');
		expect(out).toContain('--model)\n\t\t\tCOMPREPLY=( $(compgen -W "$(command veyyon __complete models -- "$cur"');
		expect(out).toContain("--resume|-r)");
		expect(out).toContain("command veyyon __complete sessions");
		// static comma list routes through the comma-aware helper
		expect(out).toContain('--tools)\n\t\t\t_veyyon_comma "read bash"');
		// multiple-value models flag also uses the comma helper
		expect(out).toContain("--models)\n\t\t\t_veyyon_comma");
	});

	it("offers subcommand names and root flags at the top level", () => {
		expect(out).toMatch(/compgen -W "commit worktree wt [^"]*--model/);
	});

	it("completes a subcommand's positional enum and its own flags", () => {
		expect(out).toContain("_veyyon_cmd_worktree()");
		expect(out).toContain('compgen -W "list clear"');
		expect(out).toContain("_veyyon_cmd_commit()");
		expect(out).toContain('compgen -W "--push"');
	});
});

describe("generateCompletion — zsh", () => {
	const out = generateCompletion("zsh", spec);

	it("emits the compdef header and dual-mode (autoload + eval) tail", () => {
		expect(out.startsWith("#compdef veyyon")).toBe(true);
		expect(out).toContain('if [ "$funcstack[1]" = "_veyyon" ]; then');
		expect(out).toContain("compdef _veyyon veyyon");
	});

	it("maps value sources to the right _arguments actions", () => {
		expect(out).toContain("'--model[Model to use]:model:_veyyon_call models'");
		expect(out).toContain("'--models[Model list]:models:_veyyon_models_list'");
		expect(out).toContain("'--thinking[Effort]:value:(low high)'");
		expect(out).toContain("'--tools[Tools]:value:_veyyon_tools'");
		expect(out).toContain("'(-r --resume)'{-r,--resume}'[Resume]:session:_veyyon_call sessions'");
		expect(out).toContain("'--session-dir[Dir]:dir:_files -/'");
		// repeatable short+long flag uses the `*{...}` form
		expect(out).toContain("'*'{-e,--extension}'[Ext]:file:_files'");
		// the static tool list helper is baked
		expect(out).toContain("_veyyon_tools() { _values -s , 'tools' read bash }");
	});

	it("dispatches aliased subcommands and completes positional enums", () => {
		expect(out).toContain("worktree|wt) _veyyon_cmd_worktree ;;");
		expect(out).toContain("':action:(list clear)'");
	});
});

describe("generateCompletion — fish", () => {
	const out = generateCompletion("fish", spec);

	it("declares the no-subcommand predicate over every command token", () => {
		expect(out).toContain("function __fish_veyyon_no_subcommand");
		expect(out).toContain("function __fish_veyyon_no_subcommand");
		expect(out).toContain("\ttest -z (__veyyon_subcommand)");
	});

	it("renders subcommand names, including aliases, with descriptions", () => {
		expect(out).toContain("-a 'commit' -d 'Commit'");
		expect(out).toContain("-a 'wt' -d 'Worktrees'");
	});

	it("maps value sources to fish completion args", () => {
		expect(out).toContain(
			"-l model -d 'Model to use' -x -a '(command veyyon __complete models -- (commandline -ct))'",
		);
		expect(out).toContain("-l thinking -d 'Effort' -x -a 'low high'");
		// A list value is comma-separated, so it goes through the comma helper
		// rather than being offered as a single value.
		expect(out).toContain("-l tools -d 'Tools' -x -a '(__veyyon_comma_candidates read bash)'");
		expect(out).toContain("-s r -l resume -d 'Resume' -x -a '(command veyyon __complete sessions");
		// a bare boolean flag takes no value
		expect(out).toContain("-s p -l print -d 'Print'");
		expect(out).not.toContain("-l print -d 'Print' -x");
	});

	it("gates a positional enum on its subcommand", () => {
		expect(out).toContain("-n '__veyyon_using worktree' -x -a 'list clear'");
	});
});

describe("buildSpec", () => {
	function fakeCmd(props: Partial<CommandCtor>): CommandCtor {
		return props as unknown as CommandCtor;
	}

	it("lifts the root command's flags and excludes root + hidden from subcommands", () => {
		const config: CliConfig = {
			bin: "veyyon",
			version: "0",
			commands: new Map<string, CommandCtor>([
				["launch", fakeCmd({ hidden: true, flags: { model: { kind: "string" } }, args: {} })],
				["__complete", fakeCmd({ hidden: true, flags: {}, args: {} })],
				["config", fakeCmd({ description: "Cfg", flags: { json: { kind: "boolean" } }, args: {} })],
			]),
		};
		const result = buildSpec(config, "launch", new Map([["config", ["c"]]]));
		// The alias comes from the shared APP_ALIAS constant, never a literal here:
		// the installers link that exact name, so a second hardcoded copy would let
		// completions bind a name no installer creates.
		expect(result.binAliases).toEqual([APP_ALIAS]);
		expect(result.bin).toBe("veyyon");

		expect(result.root.flags.map(f => f.name)).toContain("model");
		// hidden (__complete) and the root entry (launch) are both dropped
		expect(result.commands.map(c => c.name)).toEqual(["config"]);
		expect(result.commands[0]?.aliases).toEqual(["c"]);
	});

	it("classifies flag value sources from descriptor metadata", () => {
		const config: CliConfig = {
			bin: "veyyon",
			version: "0",
			commands: new Map<string, CommandCtor>([
				[
					"launch",
					fakeCmd({
						hidden: true,
						flags: {
							model: { kind: "string" },
							thinking: { kind: "string", options: ["low", "high"] },
							"no-tools": { kind: "boolean" },
							"session-dir": { kind: "string" },
						},
						args: {},
					}),
				],
			]),
		};
		const root = buildSpec(config, "launch", new Map()).root;
		const byName = new Map(root.flags.map(f => [f.name, f.value.kind]));
		expect(byName.get("model")).toBe("models");
		expect(byName.get("thinking")).toBe("enum");
		expect(byName.get("no-tools")).toBe("flag");
		expect(byName.get("session-dir")).toBe("dir");
	});
});

describe("veyyon completions (integration / drift)", () => {
	it("emits a zsh script reflecting the live command + flag surface", async () => {
		const { env, cleanup } = hermeticSpawnEnv({ VEYYON_NO_TITLE: "1" });
		let stdout: string;
		let exitCode: number;
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "completions", "zsh"], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
			[stdout, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
		} finally {
			cleanup();
		}
		expect(exitCode).toBe(0);

		// Real top-level flags from launch's static `flags` table. Flags with a
		// short char render as `{-r,--resume}`, so only assert the bracket form for
		// the long-only ones and check the char-paired form separately.
		for (const flag of ["--model", "--thinking", "--mode", "--approval-mode", "--tools", "--no-tools"]) {
			expect(stdout).toContain(`${flag}[`);
		}
		expect(stdout).toContain("{-r,--resume}");
		// Real enum option sets flow through unchanged.
		expect(stdout).toContain(":value:(off minimal low medium high xhigh max auto)");
		expect(stdout).toContain(":value:(plan ask auto-edit yolo always-ask write)");
		// Real subcommands present; dynamic callbacks wired.
		expect(stdout).toContain("_veyyon_cmd_commit");
		expect(stdout).toContain("'completions:");
		// zsh routes single-value dynamic flags through the _veyyon_call action, which
		// itself shells out to `veyyon __complete $kind`.
		expect(stdout).toContain("_veyyon_call models");
		expect(stdout).toContain("_veyyon_call sessions");
		expect(stdout).toContain("command veyyon __complete $kind");
		// Hidden/default commands must NOT surface as completable subcommands.
		expect(stdout).not.toContain("_veyyon_cmd_launch");
		expect(stdout).not.toContain("_veyyon_cmd___complete");
	});

	it("rejects an unsupported shell with a named error and exit 1", async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		let stderr: string;
		let exitCode: number;
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "completions", "tcsh"], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			stderr = await new Response(proc.stderr).text();
			exitCode = await proc.exited;
		} finally {
			cleanup();
		}
		expect(exitCode).toBe(1);
		// The message names the shell that was rejected AND the ones that work, so
		// the reader does not have to go looking for the list.
		expect(stderr).toContain('Expected shell to be one of: bash, zsh, fish, powershell; got "tcsh"');
		expect(stderr).toContain("Usage: veyyon completions <bash|zsh|fish|powershell>");
	}, 30000);
});

/**
 * `completions` parses through its own declaration, not a second scan of argv.
 *
 * It used to find the shell with `argv.find(a => !a.startsWith("-"))` and read
 * the flag with `argv.includes("--no-alias")`, next to a `static args`/`static
 * flags` declaration that said the same thing more precisely. The two
 * disagreed: `--no-alias=true` is not the string `--no-alias`, so the flag read
 * as false and the alias was bound anyway — the exact case the flag exists to
 * prevent, on an install where `vey` is someone else's command.
 */
describe("veyyon completions argument handling", () => {
	async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "completions", ...args], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { stdout, stderr, exitCode };
		} finally {
			cleanup();
		}
	}

	it("omits the alias when --no-alias is given", async () => {
		const { stdout, exitCode } = await run("bash", "--no-alias");
		expect(exitCode).toBe(0);
		expect(stdout.split("\n")).toContain("complete -F _veyyon veyyon");
	}, 30000);

	it("refuses --no-alias=true rather than quietly ignoring it", async () => {
		// This is the shape that broke: `argv.includes("--no-alias")` never matched
		// it, so the flag read as false and the alias was bound on an install where
		// `vey` belongs to someone else. Refusing is the honest answer for a
		// boolean flag that takes no argument; silently doing the opposite is not.
		const { stdout, stderr, exitCode } = await run("bash", "--no-alias=true");
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("does not take an argument");
	}, 30000);

	it("binds the alias when the flag is absent", async () => {
		const { stdout } = await run("bash");
		expect(stdout.split("\n")).toContain(`complete -F _veyyon veyyon ${APP_ALIAS}`);
	}, 30000);

	it("refuses a stray extra argument instead of ignoring it", async () => {
		// Dropping it would run a command the user did not write, at exit 0.
		const { stderr, exitCode } = await run("bash", "zsh");
		expect(exitCode).toBe(1);
		expect(stderr).toContain('Unexpected argument: "zsh"');
	}, 30000);

	it("refuses an unknown flag", async () => {
		const { stderr, exitCode } = await run("bash", "--nope");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("--nope");
	}, 30000);

	it("answers --help with exit 0, which is how the installer probes for it", async () => {
		// install.sh runs `veyyon completions --help >/dev/null 2>&1` to decide
		// whether the build it just installed can generate completions at all. A
		// non-zero exit here reads as "no completions command" and the installer
		// skips completions entirely, silently, on a build that supports them.
		const { stdout, exitCode } = await run("--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("bash|zsh|fish|powershell");
		expect(stdout).toContain("--no-alias");
	}, 30000);

	it("answers -h the same way", async () => {
		expect((await run("-h")).exitCode).toBe(0);
	}, 30000);

	it("names the missing shell rather than printing an empty error", async () => {
		const { stderr, exitCode } = await run();
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Missing required argument: shell");
		expect(stderr).toContain("Usage: veyyon completions <bash|zsh|fish|powershell>");
	}, 30000);
});

/**
 * Windows consumers had no tab completion at all.
 *
 * The three POSIX shells each autoload a file by command name, which is what
 * `install.sh` writes. PowerShell has no such directory: completion is
 * registered at runtime by `Register-ArgumentCompleter`, so the script is
 * dot-sourced from the user's profile instead. That difference is why this was
 * missing rather than merely untested, and it is why the generated script is
 * data plus one fixed completer: the tables are all that change as the CLI
 * grows, and the logic can be read once.
 *
 * pwsh is not installed on the Linux development host, so these assert the exact
 * emitted bytes rather than executing the script. Every assertion below names a
 * construct PowerShell itself would reject or misread if it were wrong.
 */
describe("generateCompletion('powershell')", () => {
	const out = generateCompletion("powershell", spec);

	it("registers a native completer for the binary AND the alias", () => {
		// `vey` is the name the docs tell users to type. PowerShell binds by
		// command name, so a registration listing only `veyyon` leaves the
		// documented entry point with nothing, the same bug the POSIX shells had.
		expect(out).toContain(
			"Register-ArgumentCompleter -Native -CommandName 'veyyon', 'vey' -ScriptBlock $__veyyonCompleter",
		);
	});

	it("offers every subcommand, including an alias token, with its description", () => {
		expect(out).toContain("'commit' = 'Commit'");
		expect(out).toContain("'worktree' = 'Worktrees'");
		// `wt` is invocable, so it must complete: a user who types `wt` and gets
		// nothing concludes completion is broken, not that the alias is undocumented.
		expect(out).toContain("'wt' = 'Worktrees'");
	});

	it("carries both the long and short form of a flag", () => {
		// PowerShell matches the token the user typed literally; omitting `-r`
		// means `-r <tab>` offers sessions for `--resume` but not for `-r`.
		expect(out).toContain(
			"'--resume' = @{ Desc = 'Resume'; Value = @{ Kind = 'sessions'; Values = @(); Multiple = $false } }",
		);
		expect(out).toContain(
			"'-r' = @{ Desc = 'Resume'; Value = @{ Kind = 'sessions'; Values = @(); Multiple = $false } }",
		);
	});

	it("bakes static enum and list candidates into the script", () => {
		expect(out).toContain(
			"'--thinking' = @{ Desc = 'Effort'; Value = @{ Kind = 'enum'; Values = @('low', 'high'); Multiple = $false } }",
		);
		expect(out).toContain(
			"'--tools' = @{ Desc = 'Tools'; Value = @{ Kind = 'list'; Values = @('read', 'bash'); Multiple = $false } }",
		);
	});

	it("records whether a model flag takes one value or many", () => {
		expect(out).toContain(
			"'--model' = @{ Desc = 'Model to use'; Value = @{ Kind = 'models'; Values = @(); Multiple = $false } }",
		);
		expect(out).toContain(
			"'--models' = @{ Desc = 'Model list'; Value = @{ Kind = 'models'; Values = @(); Multiple = $true } }",
		);
	});

	it("resolves dynamic candidates by asking the binary, exactly as the other shells do", () => {
		// The model catalog and session list are known only to the running binary.
		expect(out).toContain("& $__veyyonBin __complete $Kind -- $WordToComplete 2>$null");
		expect(out).toContain("__Veyyon-DynamicCandidates 'models' $WordToComplete");
		expect(out).toContain("__Veyyon-DynamicCandidates 'sessions' $WordToComplete");
	});

	it("splits the dynamic output on a real PowerShell tab escape", () => {
		// `__complete` emits `value<TAB>description`. A literal backslash-t here
		// would split on nothing and offer the whole line, description included,
		// as the completion text.
		expect(out).toContain('($_ -split "`t")[0]');
		expect(out).not.toContain('-split "\\t"');
	});

	it("scopes a subcommand's flags to that subcommand", () => {
		const table = out.slice(
			out.indexOf("$global:__veyyonCommandFlags = @{"),
			out.indexOf("$global:__veyyonCommandArgs = @{"),
		);
		expect(table).toContain("'commit' = @{");
		expect(table).toContain(
			"'--push' = @{ Desc = 'Push'; Value = @{ Kind = 'flag'; Values = @(); Multiple = $false } }",
		);
		// A subcommand alias must carry the same flags, or `wt --<tab>` is empty.
		expect(table).toContain("'wt' = @{");
	});

	it("offers a subcommand's positional enum values", () => {
		expect(out).toContain("'worktree' = @{ Kind = 'enum'; Values = @('list', 'clear'); Multiple = $false }");
		expect(out).toContain("'wt' = @{ Kind = 'enum'; Values = @('list', 'clear'); Multiple = $false }");
	});

	it("does not treat a flag's value as a subcommand", () => {
		// `veyyon --model commit <tab>` must not decide the user is in the `commit`
		// subcommand: `commit` there is the value of `--model`.
		expect(out).toContain("if ($expectValue) { $expectValue = $false; continue }");
		expect(out).toContain("if ($f -and $f.Value.Kind -ne 'flag') { $expectValue = $true }");
	});

	it("emits CompletionResult objects, not bare strings", () => {
		// A native completer that returns strings loses the tooltip column, which
		// is the only place a flag's description can appear in PowerShell.
		expect(out).toContain("[System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $tip)");
	});

	it("defines everything in the global scope", () => {
		// Register-ArgumentCompleter outlives the script that called it. A user who
		// RUNS this file instead of dot-sourcing it would otherwise get a
		// registered completer whose tables and helpers had already gone out of
		// scope: tab completion that silently produces nothing, with the
		// registration still in place to hide why.
		for (const name of [
			"$global:__veyyonCommands",
			"$global:__veyyonRootFlags",
			"$global:__veyyonCommandFlags",
			"$global:__veyyonCommandArgs",
			"$global:__veyyonBin",
			"$global:__veyyonCompleter",
			"function global:__Veyyon-DynamicCandidates",
			"function global:__Veyyon-ValueCandidates",
		]) {
			expect(out, `${name} must be global`).toContain(name);
		}
	});

	it("carries the already-typed prefix into path and list candidates", () => {
		// A candidate REPLACES the whole word, and the caller filters candidates
		// against that word. Bare leaf names therefore matched nothing the moment
		// the word held a separator: `-e src/ma<Tab>` and `--tools read,ba<Tab>`
		// both returned no candidates at all, which reads as "completion does not
		// work for this flag".
		expect(out).toContain("function global:__Veyyon-PrefixedPaths {");
		expect(out).toContain("if ($parent) { Join-Path $parent $_.Name } else { $_.Name }");
		expect(out).toContain("function global:__Veyyon-CommaCandidates {");
		expect(out).toContain("$prefix = $WordToComplete.Substring(0, $cut + 1)");
	});

	it("does not re-offer a list value the user already chose", () => {
		// `--tools read,<Tab>` offering `read` again is noise, and accepting it
		// produces a value the CLI would reject.
		expect(out).toContain("Where-Object { $chosen -notcontains $_ }");
	});

	it("routes file and dir through the same path helper", () => {
		// Two hand-rolled Get-ChildItem calls is how one of them keeps the bug.
		expect(out).toContain("'file' { return __Veyyon-PrefixedPaths $WordToComplete }");
		expect(out).toContain("'dir' { return __Veyyon-PrefixedPaths $WordToComplete -DirectoriesOnly }");
	});

	it("filters candidates by what the user has already typed", () => {
		expect(out).toContain('Where-Object { $_ -like "$wordToComplete*" }');
	});

	it("quotes every literal in single quotes, so no description can be executed", () => {
		// A description containing `$(...)` inside a double-quoted PowerShell
		// string would run at completion time, on every Tab press. Single quotes
		// interpret nothing, and the only escape needed is a doubled quote.
		const tables = out.slice(out.indexOf("$global:__veyyonCommands = @{"), out.indexOf("$global:__veyyonBin ="));
		expect(tables).not.toContain('"');
	});

	it("escapes an apostrophe in a description by doubling it", () => {
		const withQuote = generateCompletion("powershell", {
			...spec,
			commands: [{ name: "x", aliases: [], description: "Don't stop", flags: [], args: [] }],
		});
		expect(withQuote).toContain("'x' = 'Don''t stop'");
	});

	it("collapses a multi-line description onto one line", () => {
		// A raw newline inside the hashtable literal terminates the entry and the
		// remainder becomes a syntax error, breaking every completion in the file.
		const multiline = generateCompletion("powershell", {
			...spec,
			commands: [{ name: "x", aliases: [], description: "first line\n  second line", flags: [], args: [] }],
		});
		expect(multiline).toContain("'x' = 'first line second line'");
	});
});

/**
 * Declining to CREATE the `vey` alias was never enough.
 *
 * The installers already refuse to overwrite a `vey` the user owns, and refuse
 * to write a completion file under that name. But the script written under our
 * OWN name binds the alias too — `complete -F _veyyon veyyon vey`, `#compdef
 * veyyon vey`, `complete -c vey -w veyyon`, and a PowerShell registration
 * naming both — so bash, zsh, fish, and PowerShell all applied our completions
 * to the user's `vey` regardless of which files were copied. Their tool got our
 * subcommands.
 *
 * `--no-alias` drops the binding at the source. Every generator reads the same
 * `binAliases` list, so one empty list covers all four.
 */
describe("--no-alias omits the launch alias from every shell", () => {
	const withoutAlias = { ...spec, binAliases: [] as readonly string[] };

	it("bash binds only the binary name", () => {
		expect(generateCompletion("bash", spec)).toContain("complete -F _veyyon veyyon vey");
		// Matched as a whole line: `complete -F _veyyon veyyon` happens to contain
		// the substring "veyyon vey" inside "_veyyon veyyon".
		const lines = generateCompletion("bash", withoutAlias).split("\n");
		expect(lines).toContain("complete -F _veyyon veyyon");
		expect(lines).not.toContain("complete -F _veyyon veyyon vey");
	});

	it("zsh's #compdef line names only the binary", () => {
		// zsh binds every name on that one line, so leaving `vey` there is the
		// whole bug in a single token.
		expect(generateCompletion("zsh", spec)).toContain("#compdef veyyon vey");
		expect(generateCompletion("zsh", withoutAlias)).toContain("#compdef veyyon");
		expect(generateCompletion("zsh", withoutAlias)).not.toContain("#compdef veyyon vey");
	});

	it("fish emits no wrapping rule for the alias", () => {
		expect(generateCompletion("fish", spec)).toContain("complete -c vey -w veyyon");
		expect(generateCompletion("fish", withoutAlias)).not.toContain("complete -c vey -w veyyon");
	});

	it("PowerShell registers the completer for the binary alone", () => {
		expect(generateCompletion("powershell", withoutAlias)).toContain(
			"Register-ArgumentCompleter -Native -CommandName 'veyyon' -ScriptBlock",
		);
		expect(generateCompletion("powershell", withoutAlias)).not.toContain("'veyyon', 'vey'");
	});

	it("everything else is unchanged, so the binary keeps full completion", () => {
		// The alias is the only thing being dropped: a user who owns `vey` still
		// gets every subcommand and flag when they type `veyyon`.
		for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
			const out = generateCompletion(shell, withoutAlias);
			expect(out, `${shell} must still complete subcommands`).toContain("commit");
			expect(out, `${shell} must still complete flags`).toContain("thinking");
		}
	});
});

/**
 * A comma-separated flag value (`--tools read,bash`) completes only its LAST
 * element: a candidate replaces the whole token, so offering the bare value
 * turns `--tools read,ba<Tab>` into `--tools bash` and silently drops what the
 * user had already chosen.
 *
 * bash has `_veyyon_comma` and zsh has `_veyyon_tools`. fish was completing a
 * list flag as if it took a single value, and PowerShell had the same defect
 * when it was written.
 */
describe("comma-separated values complete one element at a time", () => {
	it("fish routes list values through a comma helper, not a bare value list", () => {
		const out = generateCompletion("fish", spec);
		expect(out).toContain("function __veyyon_comma_candidates");
		expect(out).toContain("-a '(__veyyon_comma_candidates read bash)'");
		// The enum flag next to it must stay a plain value list: only `list` is
		// comma-separated, and routing `enum` through the helper would offer
		// nonsense like `low,high`.
		expect(out).toContain("-a 'low high'");
	});

	it("fish carries the chosen elements through and does not repeat them", () => {
		const out = generateCompletion("fish", spec);
		expect(out).toContain("set -l prefix (string replace -r '[^,]*$' '' -- $cur)");
		expect(out).toContain("if not contains -- $v $chosen");
		expect(out).toContain("echo $prefix$v");
	});

	it("every shell has a comma-aware path for list values", () => {
		// The point of this test is coverage across shells: one of them silently
		// treating a list as a single value is exactly how this went unnoticed.
		expect(generateCompletion("bash", spec)).toContain('_veyyon_comma "read bash"');
		expect(generateCompletion("zsh", spec)).toContain("_veyyon_tools");
		expect(generateCompletion("fish", spec)).toContain("__veyyon_comma_candidates");
		expect(generateCompletion("powershell", spec)).toContain("__Veyyon-CommaCandidates");
	});
});

/**
 * The comma helper, RUN rather than read.
 *
 * Every other assertion in this file checks emitted text, which cannot tell
 * whether the script bash actually sources behaves correctly. These source the
 * generated completion in a real bash and call the helper, so a quoting mistake
 * that produces valid-looking but wrong output fails here.
 */
describe("the generated bash comma helper, executed", () => {
	const script = generateCompletion("bash", spec);

	/** COMPREPLY after completing `cur` against the `--tools` value list. */
	function complete(cur: string): string[] {
		const driver = [
			script,
			// compopt only works inside a real completion; stub it out.
			"compopt() { :; }",
			`cur=${JSON.stringify(cur)}`,
			"COMPREPLY=()",
			'_veyyon_comma "read bash"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			'printf "%s\\n" "${COMPREPLY[@]}"',
		].join("\n");
		const out = Bun.spawnSync(["bash", "-c", driver]);
		expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
		return new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.filter(line => line.length > 0);
	}

	it("offers every value when nothing has been typed", () => {
		expect(complete("")).toEqual(["read", "bash"]);
	});

	it("filters by the partial element under the cursor", () => {
		expect(complete("ba")).toEqual(["bash"]);
	});

	it("carries the chosen elements into each candidate", () => {
		// The candidate replaces the whole word, so a bare "bash" here would turn
		// `--tools read,` into `--tools bash` and drop the user's first choice.
		expect(complete("read,")).toEqual(["read,bash"]);
	});

	it("filters the last element while carrying the prefix", () => {
		expect(complete("read,ba")).toEqual(["read,bash"]);
	});

	it("does not offer an element the user already chose", () => {
		// Accepting it would produce `read,read`, which the CLI rejects.
		expect(complete("read,")).not.toContain("read,read");
		expect(complete("bash,")).toEqual(["bash,read"]);
	});

	it("returns nothing once every element is chosen", () => {
		expect(complete("read,bash,")).toEqual([]);
	});
});

/**
 * The dispatcher, RUN.
 *
 * `veyyon --model commit <Tab>` completed NOTHING: the loop that finds the
 * subcommand took the first token not starting with `-`, which after `--model`
 * is that flag's VALUE. It concluded the user was inside the `commit`
 * subcommand, offered commit's positionals (it has none), and the root
 * completions vanished. Reading the emitted script would not have caught this;
 * running it does.
 */
describe("the generated bash dispatcher, executed", () => {
	const script = generateCompletion("bash", spec);

	/** COMPREPLY for a command line, with the cursor on a trailing empty word. */
	function complete(...words: string[]): string[] {
		const driver = [
			script,
			"compopt() { :; }",
			`COMP_WORDS=(${words.map(w => JSON.stringify(w)).join(" ")})`,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			"COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
			"COMPREPLY=()",
			"_veyyon",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			'printf "%s\\n" "${COMPREPLY[@]}"',
		].join("\n");
		const out = Bun.spawnSync(["bash", "-c", driver]);
		expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
		return new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.filter(line => line.length > 0);
	}

	it("offers subcommands and root flags on a bare command", () => {
		const got = complete("veyyon", "");
		expect(got).toContain("commit");
		expect(got).toContain("worktree");
		expect(got).toContain("wt");
		expect(got).toContain("--model");
	});

	it("stays at the root when the previous word was a value-taking flag's value", () => {
		// The regression: `commit` here is the model name, not the subcommand.
		const got = complete("veyyon", "--model", "commit", "");
		expect(got).toContain("worktree");
		expect(got).toContain("--thinking");
	});

	it("still enters the subcommand once the flag has its value", () => {
		// The skip must consume exactly one token, not swallow the real subcommand.
		expect(complete("veyyon", "--model", "gpt", "worktree", "")).toEqual(["list", "clear"]);
	});

	it("does not skip after a boolean flag, which takes no value", () => {
		expect(complete("veyyon", "--print", "worktree", "")).toEqual(["list", "clear"]);
	});

	it("enters the subcommand under an alias token", () => {
		expect(complete("veyyon", "wt", "")).toEqual(["list", "clear"]);
	});

	it("completes a flag's enum values", () => {
		expect(complete("veyyon", "--thinking", "")).toEqual(["low", "high"]);
	});

	it("completes a subcommand's own flags", () => {
		expect(complete("veyyon", "commit", "--")).toEqual(["--push"]);
	});
});

/**
 * The @file completion, RUN against a real directory.
 *
 * Reading the emitted script cannot tell you whether the candidates come back
 * carrying their `@`, and a candidate that does not carry it is filtered out by
 * bash before the user ever sees it — the failure looks exactly like no
 * completion at all.
 */
describe("the generated bash @file completion, executed", () => {
	const atSpec: CompletionSpec = {
		bin: "veyyon",
		binAliases: [],
		root: {
			flags: [{ name: "print", char: "p", description: "Print", value: { kind: "flag" }, repeatable: false }],
			args: [{ name: "messages", description: "Messages", value: { kind: "at-file" } }],
		},
		commands: [{ name: "commit", aliases: [], description: "Commit", flags: [], args: [] }],
	};
	const script = generateCompletion("bash", atSpec);

	function completeIn(dir: string, ...words: string[]): string[] {
		const driver = [
			script,
			"compopt() { :; }",
			`cd ${JSON.stringify(dir)}`,
			`COMP_WORDS=(${words.map(w => JSON.stringify(w)).join(" ")})`,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			"COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
			"COMPREPLY=()",
			"_veyyon",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			'printf "%s\\n" "${COMPREPLY[@]}"',
		].join("\n");
		const out = Bun.spawnSync(["bash", "-c", driver]);
		expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
		return new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.filter(line => line.length > 0)
			.sort();
	}

	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(pathJoin(tmpdir(), "veyyon-atfile-"));
		mkdirSync(pathJoin(dir, "src"));
		writeFileSync(pathJoin(dir, "src", "main.ts"), "");
		writeFileSync(pathJoin(dir, "readme.md"), "");
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("offers @-prefixed paths for a bare @", () => {
		expect(completeIn(dir, "veyyon", "@")).toEqual(["@readme.md", "@src"]);
	});

	it("keeps the @ on a candidate inside a subdirectory", () => {
		// bash filters COMPREPLY against the typed word; a bare `main.ts` here
		// matches nothing and the user sees no completion at all.
		expect(completeIn(dir, "veyyon", "@src/m")).toEqual(["@src/main.ts"]);
	});

	it("still offers subcommands when the word has no @", () => {
		expect(completeIn(dir, "veyyon", "")).toContain("commit");
	});

	it("does not offer paths for a flag word", () => {
		// `--` filters the flag list to the long forms; `-p` is correctly excluded.
		expect(completeIn(dir, "veyyon", "--")).toEqual(["--print"]);
	});
});

/**
 * fish had the same defect the bash dispatcher did, arriving by a different
 * route: fish's own `__fish_seen_subcommand_from` matches any earlier token
 * against a name list, so `veyyon --model commit <Tab>` read as the `commit`
 * subcommand while the user was naming a model.
 *
 * fish is not installed on the Linux development host, so unlike the bash
 * dispatcher these assertions are on the emitted script rather than on its
 * behavior. The balance check below is here for that reason: it catches the
 * unterminated `function`/`if`/`for` that an unexecuted generator invites, which
 * would otherwise break every fish user's shell startup.
 */
describe("generateCompletion — fish subcommand detection", () => {
	const out = generateCompletion("fish", spec);
	const lines = out.split("\n").map(l => l.trim());

	it("does not use fish's own seen-subcommand predicate anywhere", () => {
		// The whole point of the replacement: that helper cannot tell a flag's
		// value from a subcommand name, and every gated rule inherits the bug.
		expect(out).not.toContain("__fish_seen_subcommand_from");
	});

	it("skips the token after a value-taking root flag", () => {
		expect(lines).toContain(
			"if contains -- $i --model --models --thinking --tools --resume -r --extension -e --session-dir",
		);
		const guard = lines.indexOf(
			"if contains -- $i --model --models --thinking --tools --resume -r --extension -e --session-dir",
		);
		expect(lines[guard + 1]).toBe("set skip 1");
	});

	it("consumes exactly one token after such a flag", () => {
		// Clearing the flag on the value itself is what lets the real subcommand
		// still be seen in `veyyon --model gpt worktree`.
		const at = lines.indexOf("if test $skip -eq 1");
		expect(lines[at + 1]).toBe("set skip 0");
		expect(lines[at + 2]).toBe("continue");
	});

	it("ignores flags that take no value", () => {
		// Without this a boolean flag would be treated as a positional and end the
		// scan, so `veyyon --print worktree <Tab>` would offer nothing.
		expect(lines).toContain("if string match -qr '^-' -- $i");
	});

	it("reports an alias token under its canonical command name", () => {
		// Rules are gated on one name; a raw token would need every alias repeated
		// at every gate.
		const at = lines.indexOf("if contains -- $i worktree wt");
		expect(lines[at + 1]).toBe("echo worktree");
	});

	it("stops at the first token that is neither a flag nor a known command", () => {
		// An unrecognized positional means the root command is handling it, so a
		// later token that happens to share a subcommand's name is not one.
		expect(lines[lines.indexOf("echo worktree") + 2]).toBe("end");
		expect(lines.filter(l => l === "return").length).toBeGreaterThanOrEqual(3);
	});

	it("erases the command name instead of slicing the token list", () => {
		// `(commandline -opc)[2..-1]` has to cope with the one-element list you get
		// at a bare `veyyon <Tab>`.
		expect(lines).toContain("set -e tokens[1]");
		expect(out).not.toContain("[2..-1]");
	});

	it("gates every subcommand rule on the canonical name", () => {
		expect(lines).toContain("function __veyyon_using");
		expect(lines).toContain("contains -- (__veyyon_subcommand) $argv");
		expect(out).toContain("-n '__veyyon_using commit'");
	});

	it("emits a syntactically balanced script", () => {
		// fish sources a completion file at startup; an unterminated block breaks
		// every new shell, and nothing here can run fish to find out.
		const code = lines.filter(l => l.length > 0 && !l.startsWith("#"));
		const opens = code.filter(l => /^(function |if |for |while |switch )/.test(l)).length;
		const ends = code.filter(l => l === "end").length;
		expect(ends).toBe(opens);
	});
});

/**
 * Positionals are answered by POSITION.
 *
 * Every subcommand handler used to offer the first enum positional's words at
 * every slot, so `veyyon config set <Tab>` proposed `list get set reset` again
 * where a setting key belongs, and kept proposing them no matter how many
 * arguments were already typed. bash is the one shell here that can count the
 * words before the cursor, so it is the one shell that can get this right.
 *
 * A dedicated spec rather than the shared one above: this needs a command with
 * three positionals of different kinds and a value-taking flag of its own, and
 * pinning that shape here keeps it from drifting with unrelated edits.
 */
describe("the generated bash positional dispatch, executed", () => {
	const positionalSpec: CompletionSpec = {
		bin: "veyyon",
		binAliases: [],
		root: {
			flags: [
				{
					name: "thinking",
					description: "Effort",
					value: { kind: "enum", values: ["low", "high"] },
					repeatable: false,
				},
			],
			args: [],
		},
		commands: [
			{
				name: "config",
				aliases: ["cfg"],
				description: "Config",
				flags: [
					{ name: "json", description: "JSON", value: { kind: "flag" }, repeatable: false },
					{
						name: "as",
						description: "Format",
						value: { kind: "enum", values: ["yaml", "toml"] },
						repeatable: false,
					},
				],
				args: [
					{ name: "action", description: "Action", value: { kind: "enum", values: ["get", "set"] } },
					{ name: "key", description: "Key", value: { kind: "value" } },
					{ name: "value", description: "Value", value: { kind: "enum", values: ["on", "off"] } },
				],
			},
		],
	};
	const script = generateCompletion("bash", positionalSpec);

	function complete(...words: string[]): string[] {
		const driver = [
			script,
			"compopt() { :; }",
			`COMP_WORDS=(${words.map(w => JSON.stringify(w)).join(" ")})`,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			"COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
			"COMPREPLY=()",
			"_veyyon",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			'printf "%s\\n" "${COMPREPLY[@]}"',
		].join("\n");
		const out = Bun.spawnSync(["bash", "-c", driver]);
		expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
		return new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.filter(line => line.length > 0);
	}

	it("offers the first positional's words in the first slot", () => {
		expect(complete("veyyon", "config", "")).toEqual(["get", "set"]);
	});

	it("does NOT repeat them in the second slot", () => {
		// The regression, exactly: `config set <Tab>` proposed the actions again.
		expect(complete("veyyon", "config", "set", "")).toEqual([]);
	});

	it("offers the third positional's words in the third slot", () => {
		// Only reachable by counting; the old handler could not see past the first
		// enum it found.
		expect(complete("veyyon", "config", "set", "startup.autoUpdate", "")).toEqual(["on", "off"]);
	});

	it("does not count a boolean flag as a positional", () => {
		// `--json` consumes no token, so the slot after it is still the first.
		expect(complete("veyyon", "config", "--json", "")).toEqual(["get", "set"]);
	});

	it("does not count a subcommand flag's VALUE as a positional", () => {
		// `yaml` is the value of --as. Counting it would shift every later slot and
		// silently complete the wrong argument.
		expect(complete("veyyon", "config", "--as", "yaml", "")).toEqual(["get", "set"]);
		expect(complete("veyyon", "config", "--as", "yaml", "set", "k", "")).toEqual(["on", "off"]);
	});

	it("counts from the subcommand, not from the start of the line", () => {
		// A root flag and its value precede the subcommand; including them would
		// make the first argument look like the third.
		expect(complete("veyyon", "--thinking", "low", "config", "")).toEqual(["get", "set"]);
	});

	it("counts the same way under an alias token", () => {
		expect(complete("veyyon", "cfg", "set", "k", "")).toEqual(["on", "off"]);
	});

	it("offers nothing past the last declared positional", () => {
		// Better than repeating the last one, which would look like the argument is
		// accepted again.
		expect(complete("veyyon", "config", "set", "k", "on", "")).toEqual([]);
	});

	it("still completes flags at any position", () => {
		expect(complete("veyyon", "config", "set", "k", "--")).toEqual(["--json", "--as"]);
	});
});

/**
 * What a value is, when nothing says.
 *
 * The classifier used to end `return { kind: "file" }` for any flag or
 * positional it did not recognize, which is most of them. The result was
 * completion that was confidently wrong: `--api-key <Tab>`, `--provider <Tab>`,
 * `ssh --host <Tab>` and `search <query> <Tab>` all listed the current
 * directory, and accepting a candidate wrote a filename where a secret, a
 * provider id, a hostname or a search term belonged. Offering nothing is the
 * honest answer for a value only the user knows; a path earns its completion by
 * being named in the classifier.
 */
describe("buildSpec value classification", () => {
	function specFor(name: string, Cmd: Record<string, unknown>): CompletionSpec {
		const commands = new Map<string, CommandCtor>([["launch", { flags: {}, args: {} } as unknown as CommandCtor]]);
		commands.set(name, Cmd as unknown as CommandCtor);
		return buildSpec({ bin: "veyyon", version: "0.0.0", commands } as CliConfig, "launch", new Map(), {});
	}

	function flagKind(name: string, descriptor: Record<string, unknown>): string {
		const spec = specFor("x", { flags: { [name]: descriptor }, args: {} });
		return spec.commands[0].flags[0].value.kind;
	}

	function argKind(command: string, name: string, descriptor: Record<string, unknown>): string {
		const spec = specFor(command, { flags: {}, args: { [name]: descriptor } });
		return spec.commands[0].args[0].value.kind;
	}

	it("gives an unrecognized flag no candidates rather than the filesystem", () => {
		expect(flagKind("api-key", { description: "API key" })).toBe("value");
		expect(flagKind("provider", { description: "Provider to use" })).toBe("value");
		expect(flagKind("host", { description: "Host address" })).toBe("value");
	});

	it("gives an unrecognized positional no candidates either", () => {
		expect(argKind("search", "query", { description: "Search query text" })).toBe("value");
		expect(argKind("say", "text", { description: "Text to speak" })).toBe("value");
		expect(argKind("token", "provider", { description: "Provider ID" })).toBe("value");
	});

	it("still completes paths for the flags that really take one", () => {
		expect(flagKind("config", { description: "Overlay" })).toBe("file");
		expect(flagKind("extension", { description: "Extension file" })).toBe("file");
		expect(flagKind("out", { description: "Output path" })).toBe("file");
		expect(flagKind("cwd", { description: "Directory to start in" })).toBe("dir");
		expect(flagKind("dir", { description: "Output directory" })).toBe("dir");
	});

	it("completes paths for the positionals that really take one", () => {
		expect(argKind("read", "path", { description: "Path to read" })).toBe("file");
		expect(argKind("grep", "path", { description: "Directory or file" })).toBe("file");
		expect(argKind("install", "targets", { description: "Local path or spec" })).toBe("file");
	});

	it("keys positionals by command, because a positional name means different things", () => {
		// `read <path>` is a file; `ttsr --path` is a file; a hypothetical
		// `search <path>` would not be. Bare-name keying could not express that.
		expect(argKind("read", "path", { description: "Path" })).toBe("file");
		expect(argKind("search", "path", { description: "Not a path" })).toBe("value");
	});

	it("resolves the hand-off model flags against the model catalog", () => {
		// Both name the model a phase hands off to. They were classified as files,
		// so `--prewalk-into <Tab>` listed the current directory instead of models.
		expect(flagKind("prewalk-into", { description: "Target model for prewalk" })).toBe("models");
		expect(flagKind("plan-yolo-into", { description: "Target model for plan-yolo" })).toBe("models");
	});

	it("resolves model positionals against the catalog too", () => {
		expect(argKind("bench/throughput", "models", { description: "Model selectors" })).toBe("models");
		expect(argKind("dry-balance", "model", { description: "Model selector" })).toBe("models");
		expect(argKind("tiny-models", "model", { description: "Model key" })).toBe("models");
	});

	it("lets a declared option list win over every name rule", () => {
		// An explicit `options` list is the command author speaking directly; no
		// heuristic should override it.
		expect(flagKind("config", { description: "Overlay", options: ["a", "b"] })).toBe("enum");
		expect(argKind("read", "path", { description: "Path", options: ["a", "b"] })).toBe("enum");
	});

	it("a value with no candidates emits no completion action in bash", () => {
		// The end-to-end consequence: the handler returns without touching
		// COMPREPLY, so bash falls back to its own default instead of pretending.
		const spec = specFor("say", { flags: {}, args: { text: { description: "Text to speak" } } });
		expect(generateCompletion("bash", spec)).not.toContain("compgen -f");
	});
});

/**
 * Setting keys and setting values, in every shell.
 *
 * `veyyon config set <Tab>` offered nothing: the key is free text as far as the
 * static spec is concerned, and the schema that knows every setting was never
 * asked. Both new sources resolve through the binary, and the value source
 * needs the key the user just typed, which each shell names differently.
 */
describe("settings completion reaches every shell", () => {
	const settingsSpec: CompletionSpec = {
		bin: "veyyon",
		binAliases: [],
		root: { flags: [], args: [] },
		commands: [
			{
				name: "config",
				aliases: [],
				description: "Config",
				flags: [],
				args: [
					{ name: "action", description: "Action", value: { kind: "enum", values: ["get", "set"] } },
					{ name: "key", description: "Key", value: { kind: "settings" } },
					{ name: "value", description: "Value", value: { kind: "setting-values" } },
				],
			},
		],
	};

	it("buildSpec routes config's key and value to the schema, not to the filesystem", () => {
		const commands = new Map<string, CommandCtor>([
			["launch", { flags: {}, args: {} } as unknown as CommandCtor],
			[
				"config",
				{
					flags: {},
					args: { action: { description: "A" }, key: { description: "K" }, value: { description: "V" } },
				} as unknown as CommandCtor,
			],
		]);
		const built = buildSpec({ bin: "veyyon", version: "0", commands } as CliConfig, "launch", new Map(), {});
		expect(built.commands[0].args.map(a => a.value.kind)).toEqual(["value", "settings", "setting-values"]);
	});

	it("bash asks the binary for keys, and for values names the preceding word", () => {
		const out = generateCompletion("bash", settingsSpec);
		expect(out).toContain('command veyyon __complete settings -- "$cur"');
		expect(out).toContain('command veyyon __complete setting-values "$prev" -- "$cur"');
	});

	it("bash does not re-filter dynamic candidates the binary already filtered", () => {
		// compgen's own `-- "$cur"` match is a PREFIX match. Applying it on top of
		// the binary's own matching threw the difference away: `--model opus<Tab>`
		// dropped every `anthropic/claude-opus-…` the helper had just returned.
		const out = generateCompletion("bash", settingsSpec);
		expect(out).not.toContain('__complete settings -- "$cur" 2>/dev/null | cut -f1)" -- "$cur"');
	});

	it("zsh routes both through its describe helpers", () => {
		const out = generateCompletion("zsh", settingsSpec);
		// The positional spec and the flag spec share one completer mapping, so a
		// positional gets the same answer a flag of that kind would.
		expect(out).toContain("':key:_veyyon_call settings'");
		expect(out).toContain("':value:_veyyon_setting_values'");
		expect(out).not.toContain("_files");
		expect(out).toContain("_veyyon_setting_values() {");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
		expect(out).toContain('"${words[CURRENT-1]}"');
	});

	it("fish reads the preceding word from the completed words", () => {
		const out = generateCompletion("fish", settingsSpec);
		expect(out).toContain("function __veyyon_prev_word");
		expect(out).toContain("__complete setting-values (__veyyon_prev_word)");
	});

	it("powershell passes the preceding token as the subject", () => {
		const out = generateCompletion("powershell", settingsSpec);
		expect(out).toContain("'settings' { return __Veyyon-DynamicCandidates 'settings' $WordToComplete }");
		expect(out).toContain("__Veyyon-DynamicCandidates 'setting-values' $WordToComplete $Previous");
	});

	it("powershell has ONE helper that talks to the binary, not two", () => {
		// A second copy of the spawn-and-split-on-tab logic is a second place for
		// the wire format to drift.
		const out = generateCompletion("powershell", settingsSpec);
		expect(out.split("\n").filter(l => l.includes("$__veyyonBin __complete"))).toHaveLength(2);
		expect(out).toContain("function global:__Veyyon-DynamicCandidates {");
		expect(out).not.toContain("function global:__Veyyon-SettingValues");
	});

	it("powershell declines to ask for values with no key", () => {
		// $Previous is whatever word precedes the cursor, which is often nothing.
		expect(generateCompletion("powershell", settingsSpec)).toContain("if (-not $Previous) { return @() }");
	});

	it("the fish script stays balanced with the new helper", () => {
		const code = generateCompletion("fish", settingsSpec)
			.split("\n")
			.map(l => l.trim())
			.filter(l => l.length > 0 && !l.startsWith("#"));
		expect(code.filter(l => l === "end").length).toBe(
			code.filter(l => /^(function |if |for |while |switch )/.test(l)).length,
		);
	});
});

/**
 * The bash side of setting completion, RUN, with the binary stubbed.
 *
 * The generated script shells out to `veyyon __complete`; the wire format is
 * covered against the real CLI in complete-command.test.ts. What is only
 * provable here is that the script passes the right words and puts the answer
 * where bash reads it.
 */
describe("the generated bash settings completion, executed", () => {
	const settingsSpec: CompletionSpec = {
		bin: "veyyon",
		binAliases: [],
		root: { flags: [], args: [] },
		commands: [
			{
				name: "config",
				aliases: [],
				description: "Config",
				flags: [],
				args: [
					{ name: "action", description: "Action", value: { kind: "enum", values: ["get", "set"] } },
					{ name: "key", description: "Key", value: { kind: "settings" } },
					{ name: "value", description: "Value", value: { kind: "setting-values" } },
				],
			},
		],
	};
	const script = generateCompletion("bash", settingsSpec);

	// Stands in for the binary: echoes back what it was asked, in the wire format.
	const stub = [
		"veyyon() {",
		'  if [ "$2" = "settings" ]; then printf "startup.autoUpdate\\tUpdates\\nstartup.quiet\\tQuiet\\n";',
		'  elif [ "$2" = "setting-values" ]; then printf "%s.true\\tv\\n%s.false\\tv\\n" "$3" "$3";',
		"  fi",
		"}",
		'command() { shift; veyyon "$@"; }',
	].join("\n");

	function complete(...words: string[]): string[] {
		const driver = [
			script,
			stub,
			"compopt() { :; }",
			`COMP_WORDS=(${words.map(w => JSON.stringify(w)).join(" ")})`,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			"COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
			"COMPREPLY=()",
			"_veyyon",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
			'printf "%s\\n" "${COMPREPLY[@]}"',
		].join("\n");
		const out = Bun.spawnSync(["bash", "-c", driver]);
		expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
		return new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.filter(line => line.length > 0);
	}

	it("offers setting keys in the key slot", () => {
		expect(complete("veyyon", "config", "set", "")).toEqual(["startup.autoUpdate", "startup.quiet"]);
	});

	it("passes the key the user typed when asking for values", () => {
		// The whole point of the setting-values source: the answer depends on which
		// setting is being set.
		expect(complete("veyyon", "config", "set", "startup.quiet", "")).toEqual([
			"startup.quiet.true",
			"startup.quiet.false",
		]);
	});

	it("keeps candidates the binary returned that do not start with the typed word", () => {
		// The double-filter regression, executed: the stub returns dotted keys, and
		// a prefix match against `up` would drop both.
		expect(complete("veyyon", "config", "set", "up")).toEqual(["startup.autoUpdate", "startup.quiet"]);
	});
});

/**
 * `veyyon @src/main.ts explain this` is a documented way to launch: the launch
 * positional is free text, except that a word starting with `@` names a file to
 * attach. Completion never knew that, so the one part of that line a shell
 * could have completed was the part it left alone.
 *
 * The `@` is not part of the path, and it IS part of the word a candidate
 * replaces, so every shell has to strip it for the lookup and put it back on
 * the result. Getting that backwards produces no candidates at all, which is
 * indistinguishable from the bug being unfixed.
 */
describe("the @file launch positional", () => {
	const atSpec: CompletionSpec = {
		bin: "veyyon",
		binAliases: [],
		root: {
			flags: [{ name: "print", char: "p", description: "Print", value: { kind: "flag" }, repeatable: false }],
			args: [
				{ name: "messages", description: "Messages to send (prefix files with @)", value: { kind: "at-file" } },
			],
		},
		commands: [{ name: "commit", aliases: [], description: "Commit", flags: [], args: [] }],
	};

	it("buildSpec classifies the launch messages positional as @file", () => {
		const commands = new Map<string, CommandCtor>([
			[
				"launch",
				{ flags: {}, args: { messages: { description: "Messages", multiple: true } } } as unknown as CommandCtor,
			],
		]);
		const built = buildSpec({ bin: "veyyon", version: "0", commands } as CliConfig, "launch", new Map(), {});
		expect(built.root.args[0].value.kind).toBe("at-file");
	});

	it("bash strips the @ for the lookup and puts it back on every candidate", () => {
		const out = generateCompletion("bash", atSpec);
		expect(out).toContain("_veyyon_at_file() {");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
		expect(out).toContain('local realcur="${cur#@}"');
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash/zsh completion source; the ${...} is shell syntax under test.
		expect(out).toContain('matches[i]="@${matches[i]}"');
	});

	it("bash routes to it only when the word already starts with @", () => {
		// Without the guard the root would offer paths instead of subcommands.
		expect(generateCompletion("bash", atSpec)).toContain('if [[ "$cur" == @* ]]; then');
	});

	it("zsh moves the @ out of the way with compset so _files still matches", () => {
		const out = generateCompletion("zsh", atSpec);
		expect(out).toContain("compset -P '@'");
		expect(out).toContain("'1: :_veyyon_first_word'");
	});

	it("fish returns nothing unless the word starts with @", () => {
		const out = generateCompletion("fish", atSpec);
		expect(out).toContain("function __veyyon_at_file_candidates");
		expect(out).toContain("string match -q '@*' -- $cur; or return");
		expect(out).toContain("-a '(__veyyon_at_file_candidates)'");
	});

	it("powershell declines a word with no @ and re-prefixes the rest", () => {
		const out = generateCompletion("powershell", atSpec);
		expect(out).toContain("if (-not $WordToComplete.StartsWith('@')) { return @() }");
		expect(out).toContain('ForEach-Object { "@$_" }');
	});

	it("emits none of it for a CLI whose root takes no @file positional", () => {
		// Dead helpers in a script every shell sources at startup are not free.
		const plain: CompletionSpec = { ...atSpec, root: { flags: atSpec.root.flags, args: [] } };
		expect(generateCompletion("bash", plain)).not.toContain("_veyyon_at_file");
		expect(generateCompletion("zsh", plain)).not.toContain("_veyyon_at_file");
		expect(generateCompletion("zsh", plain)).toContain("'1: :_veyyon_commands'");
		expect(generateCompletion("fish", plain)).not.toContain("__veyyon_at_file_candidates");
	});
});

/**
 * A positional with no candidates must emit no fish rule at all.
 *
 * fishValue returns a bare `-x` for such a value. On a FLAG that reads "this
 * flag takes a value, do not offer files for it". On a POSITIONAL there is no
 * flag to attach it to, so it becomes an unconditional rule that turns file
 * completion off for the whole subcommand — `grep <pattern>` would have
 * cancelled the file completion `grep <path>` asks for on the next line.
 */
describe("fish positionals with nothing to offer", () => {
	const grepLike: CompletionSpec = {
		bin: "veyyon",
		binAliases: [],
		root: { flags: [], args: [] },
		commands: [
			{
				name: "grep",
				aliases: [],
				description: "Grep",
				flags: [],
				args: [
					{ name: "pattern", description: "Regex pattern", value: { kind: "value" } },
					{ name: "path", description: "Directory or file", value: { kind: "file" } },
				],
			},
		],
	};

	it("emits the file positional and not the free-text one", () => {
		const lines = generateCompletion("fish", grepLike)
			.split("\n")
			.filter(l => l.includes("__veyyon_using grep"));
		expect(lines).toEqual(["complete -c veyyon -n '__veyyon_using grep' -r -F -d 'Directory or file'"]);
	});

	it("keeps emitting the bare -x for FLAGS, where it means something", () => {
		const withFlag: CompletionSpec = {
			...grepLike,
			commands: [
				{
					...grepLike.commands[0],
					flags: [{ name: "glob", description: "Glob", value: { kind: "value" }, repeatable: false }],
				},
			],
		};
		expect(generateCompletion("fish", withFlag)).toContain("-l glob -d 'Glob' -x");
	});
});
