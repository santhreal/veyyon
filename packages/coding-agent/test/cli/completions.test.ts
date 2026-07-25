import { describe, expect, it } from "bun:test";
import * as path from "node:path";
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
		expect(out).toContain("if contains -- $i commit worktree wt");
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
		expect(out).toContain("-l tools -d 'Tools' -x -a 'read bash'");
		expect(out).toContain("-s r -l resume -d 'Resume' -x -a '(command veyyon __complete sessions");
		// a bare boolean flag takes no value
		expect(out).toContain("-s p -l print -d 'Print'");
		expect(out).not.toContain("-l print -d 'Print' -x");
	});

	it("gates a positional enum on its subcommand", () => {
		expect(out).toContain("-n '__fish_seen_subcommand_from worktree wt' -a 'list clear'");
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
		expect(stderr).toContain('Error: unsupported shell "tcsh"');
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
		const table = out.slice(out.indexOf("$global:__veyyonCommandFlags = @{"), out.indexOf("$global:__veyyonCommandArgs = @{"));
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
