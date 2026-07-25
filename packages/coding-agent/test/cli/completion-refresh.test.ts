/**
 * `veyyon update` swapped the binary and left the installed shell completions
 * alone, so every subcommand and flag a release added was missing from tab
 * completion until the user happened to re-run the installer. These tests lock
 * the refresh that closes that gap, and — more importantly — lock the two rules
 * that keep it from becoming destructive:
 *
 * 1. It rewrites only files that already exist. Creating completions is the
 *    installer's job; an update that conjured them would override a user who
 *    deliberately does not want them.
 * 2. Its paths mirror `completions_dir_for` / `completion_file_for` in
 *    scripts/install.sh exactly. If the two drift, the update rewrites files the
 *    installer never wrote and misses the ones it did — which is worse than the
 *    staleness it was added to fix.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AUTOLOADED_COMPLETION_SHELLS,
	type CompletionEnv,
	type CompletionShell,
	completionEnvFrom,
	completionFileFor,
	completionsDirFor,
	completionTargets,
	powershellCompletionPath,
	refreshInstalledCompletions,
	scriptBindsAlias,
} from "../../src/cli/completion-refresh";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");

describe("completion paths mirror the installer that wrote the files", () => {
	const env: CompletionEnv = { HOME: "/home/u" };

	it("resolves each shell's directory to the same place install.sh does", () => {
		expect(completionsDirFor("bash", env)).toBe("/home/u/.local/share/bash-completion/completions");
		expect(completionsDirFor("zsh", env)).toBe("/home/u/.local/share/zsh/site-functions");
		expect(completionsDirFor("fish", env)).toBe("/home/u/.config/fish/completions");
	});

	it("honours XDG_DATA_HOME and XDG_CONFIG_HOME, as the installer does", () => {
		// install.sh reads ${XDG_DATA_HOME:-$HOME/.local/share}; a refresh that
		// ignored the override would rewrite a directory nobody installed into.
		const xdg: CompletionEnv = { HOME: "/home/u", XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/conf" };
		expect(completionsDirFor("bash", xdg)).toBe("/data/bash-completion/completions");
		expect(completionsDirFor("zsh", xdg)).toBe("/data/zsh/site-functions");
		expect(completionsDirFor("fish", xdg)).toBe("/conf/fish/completions");
	});

	it("treats an empty XDG variable as unset, matching ${VAR:-default}", () => {
		// `${XDG_DATA_HOME:-...}` falls back on empty as well as unset; `??` would
		// not, and would resolve completions to a path starting at "/".
		const empty: CompletionEnv = { HOME: "/home/u", XDG_DATA_HOME: "", XDG_CONFIG_HOME: "" };
		expect(completionsDirFor("bash", empty)).toBe("/home/u/.local/share/bash-completion/completions");
		expect(completionsDirFor("fish", empty)).toBe("/home/u/.config/fish/completions");
	});

	it("names each file exactly as its shell autoloads it", () => {
		expect(completionFileFor("bash", "veyyon")).toBe("veyyon");
		expect(completionFileFor("zsh", "veyyon")).toBe("_veyyon");
		expect(completionFileFor("fish", "veyyon")).toBe("veyyon.fish");
	});

	it("the directory rules still read the same in install.sh", () => {
		// The two implementations are in different languages and cannot share code,
		// so the shell source is asserted directly: a change to one that is not
		// mirrored in the other fails here rather than in a user's shell.
		expect(installSh).toContain('bash) echo "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"');
		expect(installSh).toContain('zsh)  echo "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions"');
		expect(installSh).toContain('fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"');
		expect(installSh).toContain('bash) echo "$2"');
		expect(installSh).toContain('zsh)  echo "_$2"');
		expect(installSh).toContain('fish) echo "$2.fish"');
	});

	it("covers the alias for bash and fish, and gives zsh exactly one file", () => {
		// bash and fish autoload by the command name being completed, so the alias
		// needs its own file. zsh binds both names from one `#compdef` line, and
		// install.sh deliberately writes no `_vey`; refreshing one would create a
		// file the installer never wrote and uninstall does not know about.
		const targets = completionTargets({ HOME: "/home/u" }, "veyyon", "vey");
		const paths = targets.map(t => t.filePath);
		expect(paths).toContain("/home/u/.local/share/bash-completion/completions/veyyon");
		expect(paths).toContain("/home/u/.local/share/bash-completion/completions/vey");
		expect(paths).toContain("/home/u/.config/fish/completions/veyyon.fish");
		expect(paths).toContain("/home/u/.config/fish/completions/vey.fish");
		expect(paths).toContain("/home/u/.local/share/zsh/site-functions/_veyyon");
		expect(paths).not.toContain("/home/u/.local/share/zsh/site-functions/_vey");
		expect(paths).toHaveLength(5);
	});

	it("completionEnvFrom keeps only the three variables that matter", () => {
		const narrowed = completionEnvFrom({ HOME: "/h", XDG_DATA_HOME: "/d", PATH: "/usr/bin", SHELL: "/bin/zsh" });
		expect(narrowed).toEqual({ HOME: "/h", XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: undefined });
	});
});

/** The three shells whose completion file lives in an autoloaded directory. */
type AutoloadedShell = (typeof AUTOLOADED_COMPLETION_SHELLS)[number];

describe("refreshInstalledCompletions", () => {
	let home: string;
	let env: CompletionEnv;

	/** The path install.sh would have written for this shell and command name. */
	function target(shell: AutoloadedShell, name: string): string {
		return path.join(completionsDirFor(shell, env), completionFileFor(shell, name));
	}

	/** Seed a completion file as an earlier install would have left it. */
	function seed(shell: AutoloadedShell, name: string, body = "# stale\n"): string {
		const file = target(shell, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
		return file;
	}

	const generate = async (shell: CompletionShell) => `# fresh ${shell}\n`;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-completions-"));
		env = { HOME: home };
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("replaces the content of a completion the installer left behind", () => {
		const file = seed("fish", "veyyon");
		return refreshInstalledCompletions({ env, binName: "veyyon", aliasName: "vey", generate }).then(result => {
			expect(fs.readFileSync(file, "utf8")).toBe("# fresh fish\n");
			expect(result.refreshed).toEqual([file]);
			expect(result.failed).toEqual([]);
		});
	});

	it("never creates a completion the user does not already have", async () => {
		// The whole point of gating on existence: an update must not decide for the
		// user which shells get completions, and must not write files that
		// `install.sh --uninstall` would then have to know about.
		const result = await refreshInstalledCompletions({ env, binName: "veyyon", aliasName: "vey", generate });
		expect(result.refreshed).toEqual([]);
		expect(fs.existsSync(completionsDirFor("bash", env))).toBe(false);
		expect(fs.existsSync(completionsDirFor("zsh", env))).toBe(false);
		expect(fs.existsSync(completionsDirFor("fish", env))).toBe(false);
	});

	it("refreshes the alias file too, and only when it exists", async () => {
		// `vey` is the name the docs tell users to type; leaving its completion
		// stale would fix tab completion for the name almost nobody uses.
		const binFile = seed("bash", "veyyon");
		const aliasFile = seed("bash", "vey");
		const fishBin = seed("fish", "veyyon");
		// No fish alias file: a user whose alias was declined (see install.sh's
		// ALIAS_IS_OURS) must not have one materialize now.
		const result = await refreshInstalledCompletions({ env, binName: "veyyon", aliasName: "vey", generate });
		expect(fs.readFileSync(binFile, "utf8")).toBe("# fresh bash\n");
		expect(fs.readFileSync(aliasFile, "utf8")).toBe("# fresh bash\n");
		expect(fs.readFileSync(fishBin, "utf8")).toBe("# fresh fish\n");
		expect(fs.existsSync(target("fish", "vey"))).toBe(false);
		expect(result.refreshed).toHaveLength(3);
	});

	it("generates once per shell, not once per file", async () => {
		// Each generation forks the freshly installed binary; doing it twice for
		// bash's two identical files doubles the cost of every update for nothing.
		seed("bash", "veyyon");
		seed("bash", "vey");
		const calls: CompletionShell[] = [];
		await refreshInstalledCompletions({
			env,
			binName: "veyyon",
			aliasName: "vey",
			generate: async shell => {
				calls.push(shell);
				return `# fresh ${shell}\n`;
			},
		});
		expect(calls).toEqual(["bash"]);
	});

	it("reports a generator failure instead of throwing, and leaves the old file intact", async () => {
		// The binary update itself already succeeded and was version-verified.
		// Failing the whole update over a completion script would turn a cosmetic
		// problem into a broken install, so this path reports and continues.
		const file = seed("zsh", "veyyon", "# previous version\n");
		const result = await refreshInstalledCompletions({
			env,
			binName: "veyyon",
			aliasName: "vey",
			generate: async () => {
				throw new Error("exited 1: unknown command");
			},
		});
		expect(result.refreshed).toEqual([]);
		expect(result.failed).toEqual([{ filePath: file, reason: "exited 1: unknown command" }]);
		expect(fs.readFileSync(file, "utf8")).toBe("# previous version\n");
	});

	it("treats an empty generated script as a failure, not as content", async () => {
		// Overwriting a working completion with nothing is the silent degrade this
		// codebase forbids: tab completion would stop working with no error at all.
		const file = seed("fish", "veyyon", "# previous version\n");
		const result = await refreshInstalledCompletions({
			env,
			binName: "veyyon",
			aliasName: "vey",
			generate: async () => "",
		});
		expect(fs.readFileSync(file, "utf8")).toBe("# previous version\n");
		expect(result.failed[0]?.reason).toContain("generated empty");
	});

	it("keeps refreshing other shells after one of them fails", async () => {
		// A broken zsh generator must not cost the user their bash completions.
		const zshFile = seed("zsh", "veyyon");
		const bashFile = seed("bash", "veyyon");
		const result = await refreshInstalledCompletions({
			env,
			binName: "veyyon",
			aliasName: "vey",
			generate: async shell => {
				if (shell === "zsh") throw new Error("boom");
				return `# fresh ${shell}\n`;
			},
		});
		expect(fs.readFileSync(bashFile, "utf8")).toBe("# fresh bash\n");
		expect(result.refreshed).toContain(bashFile);
		expect(result.failed.map(f => f.filePath)).toEqual([zshFile]);
	});

	it("leaves no temporary file behind on success", async () => {
		// A completion directory is autoloaded wholesale by bash; a leftover
		// `veyyon.1234.new` would be sourced as a second, half-named completion.
		seed("bash", "veyyon");
		await refreshInstalledCompletions({ env, binName: "veyyon", aliasName: "vey", generate });
		expect(fs.readdirSync(completionsDirFor("bash", env))).toEqual(["veyyon"]);
	});

	it("writes through a temp file so a reader never sees a partial script", async () => {
		// The final path must go from old content to new content with nothing in
		// between: a shell that sources a truncated completion at startup breaks
		// every terminal the user opens until they notice and delete it.
		const file = seed("bash", "veyyon", "# previous version\n");
		let observedDuringWrite = "";
		await refreshInstalledCompletions({
			env,
			binName: "veyyon",
			aliasName: "vey",
			generate: async shell => {
				observedDuringWrite = fs.readFileSync(file, "utf8");
				return `# fresh ${shell}\n`;
			},
		});
		expect(observedDuringWrite).toBe("# previous version\n");
		expect(fs.readFileSync(file, "utf8")).toBe("# fresh bash\n");
	});

	it("reports an unwritable completion file rather than failing the update", async () => {
		// A root-owned completion directory (a distro package, a sudo install) is a
		// real configuration, and the user needs to be told which file is stale.
		const dir = completionsDirFor("fish", env);
		const file = seed("fish", "veyyon", "# previous version\n");
		fs.chmodSync(dir, 0o500);
		try {
			const result = await refreshInstalledCompletions({ env, binName: "veyyon", aliasName: "vey", generate });
			expect(result.refreshed).toEqual([]);
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]?.filePath).toBe(file);
			expect(fs.readFileSync(file, "utf8")).toBe("# previous version\n");
		} finally {
			fs.chmodSync(dir, 0o700);
		}
	});
});

/**
 * Windows has no directory a shell autoloads completions from, so install.ps1
 * writes a script beside the profile and adds a dot-source line to it. That
 * file goes stale on update exactly like the POSIX ones, and it is invisible to
 * the directory walk above, so it is passed in as an extra target.
 */
describe("the PowerShell completion script", () => {
	it("sits beside the profile, named for the binary, as install.ps1 writes it", () => {
		// Built with the host's own separator: this runs on the development host
		// as well as on Windows, and the production path is always native.
		const profileDir = path.join("Documents", "PowerShell");
		expect(powershellCompletionPath(path.join(profileDir, "profile.ps1"), "veyyon")).toBe(
			path.join(profileDir, "veyyon-completions.ps1"),
		);
	});

	it("uses the binary's own name, so a rename cannot orphan the file", () => {
		expect(powershellCompletionPath(path.join("p", "profile.ps1"), "other")).toBe(
			path.join("p", "other-completions.ps1"),
		);
	});

	it("install.ps1 still derives the same filename", () => {
		// The two implementations cannot share code, so the shell source is
		// asserted directly: a rename on one side that is not mirrored would make
		// the update rewrite a file the installer never wrote.
		const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");
		expect(installPs1).toContain('"$BinName-completions.ps1"');
		expect(installPs1).toContain("Split-Path -Parent (Get-ProfilePath)");
	});

	it("is refreshed when it exists, and never created when it does not", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-ps-completions-"));
		try {
			const profileDir = path.join(home, "Documents", "PowerShell");
			fs.mkdirSync(profileDir, { recursive: true });
			const scriptPath = powershellCompletionPath(path.join(profileDir, "profile.ps1"), "veyyon");
			const absent = powershellCompletionPath(path.join(home, "Other", "profile.ps1"), "veyyon");
			fs.writeFileSync(scriptPath, "# from the previous version\n");

			const result = await refreshInstalledCompletions({
				env: { HOME: home },
				binName: "veyyon",
				aliasName: "vey",
				generate: async shell => `# fresh ${shell}\n`,
				extraTargets: [
					{ shell: "powershell", commandName: "veyyon", filePath: scriptPath },
					{ shell: "powershell", commandName: "veyyon", filePath: absent },
				],
			});

			expect(fs.readFileSync(scriptPath, "utf8")).toBe("# fresh powershell\n");
			expect(result.refreshed).toEqual([scriptPath]);
			expect(fs.existsSync(absent)).toBe(false);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

/**
 * An update must not reverse the installer's decision about the launch alias.
 *
 * The installer checks whether the `vey` on PATH is the symlink it created, and
 * passes `--no-alias` when it is not: binding a name that belongs to someone
 * else's tool would give that tool our subcommands. The refresh regenerated
 * from the binary with no flag at all, so the first update after install bound
 * `vey` anyway — silently, on exactly the machine where it must not.
 *
 * The refresh cannot repeat the PATH check cheaply and must not guess. The file
 * the installer wrote IS the record of the decision, so it is read back.
 */
describe("refreshInstalledCompletions carries the alias decision forward", () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-alias-decision-"));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	const env = () => ({ HOME: home, XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined });

	function seed(relative: string[], body: string): string {
		const file = path.join(home, ...relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
		return file;
	}

	/** Runs a refresh and records the (shell, noAlias) pairs the generator saw. */
	async function refreshRecording(): Promise<{ shell: string; noAlias: boolean }[]> {
		const calls: { shell: string; noAlias: boolean }[] = [];
		await refreshInstalledCompletions({
			env: env(),
			binName: "veyyon",
			aliasName: "vey",
			generate: async (shell, noAlias) => {
				calls.push({ shell, noAlias });
				return `# regenerated ${shell}\n`;
			},
		});
		return calls;
	}

	it("asks for --no-alias when the installed script does not bind the alias", async () => {
		seed([".config", "fish", "completions", "veyyon.fish"], "complete -c veyyon -f -a 'commit'\n");
		expect(await refreshRecording()).toEqual([{ shell: "fish", noAlias: true }]);
	});

	it("keeps the alias when the installed script binds it", async () => {
		seed([".config", "fish", "completions", "veyyon.fish"], "complete -c veyyon -f\ncomplete -c vey -w veyyon\n");
		expect(await refreshRecording()).toEqual([{ shell: "fish", noAlias: false }]);
	});

	it("treats an alias-named file as proof the alias is ours", async () => {
		// bash and fish key a completion file on the command name, so a `vey` file
		// exists only because the installer created it.
		seed([".config", "fish", "completions", "vey.fish"], "# whatever\n");
		expect(await refreshRecording()).toEqual([{ shell: "fish", noAlias: false }]);
	});

	it("does not read `vey` out of the word `veyyon`", async () => {
		// Every line of every script contains the binary name, and the alias is a
		// prefix of it. A substring test would report the alias bound always, which
		// is the failure mode this whole check exists to avoid.
		seed([".local", "share", "zsh", "site-functions", "_veyyon"], "#compdef veyyon\n_veyyon_cmd_veyyon() { : }\n");
		expect(await refreshRecording()).toEqual([{ shell: "zsh", noAlias: true }]);
	});

	it("reads the zsh compdef line, which is where zsh binds both names", async () => {
		seed([".local", "share", "zsh", "site-functions", "_veyyon"], "#compdef veyyon vey\n");
		expect(await refreshRecording()).toEqual([{ shell: "zsh", noAlias: false }]);
	});

	it("decides per shell, because each file records its own install", async () => {
		// The shells are installed independently and one can be edited by hand.
		seed([".config", "fish", "completions", "veyyon.fish"], "complete -c vey -w veyyon\n");
		seed([".local", "share", "zsh", "site-functions", "_veyyon"], "#compdef veyyon\n");
		const calls = await refreshRecording();
		expect(calls).toContainEqual({ shell: "fish", noAlias: false });
		expect(calls).toContainEqual({ shell: "zsh", noAlias: true });
	});

	it("writes the regenerated script to every file of that shell", async () => {
		// One generation per shell, reused across the binary's file and the alias's.
		const binFile = seed([".local", "share", "bash-completion", "completions", "veyyon"], "# old\n");
		const aliasFile = seed([".local", "share", "bash-completion", "completions", "vey"], "# old\n");
		const result = await refreshInstalledCompletions({
			env: env(),
			binName: "veyyon",
			aliasName: "vey",
			generate: async () => "# fresh\n",
		});
		expect(result.failed).toEqual([]);
		expect(new Set(result.refreshed)).toEqual(new Set([binFile, aliasFile]));
		expect(fs.readFileSync(binFile, "utf8")).toBe("# fresh\n");
		expect(fs.readFileSync(aliasFile, "utf8")).toBe("# fresh\n");
	});
});

describe("scriptBindsAlias", () => {
	it("matches the alias as a standalone word", () => {
		expect(scriptBindsAlias("complete -F _veyyon veyyon vey", "vey")).toBe(true);
		expect(scriptBindsAlias("#compdef veyyon vey", "vey")).toBe(true);
		expect(scriptBindsAlias("complete -c vey -w veyyon", "vey")).toBe(true);
	});

	it("does not match the alias inside the binary name", () => {
		// `vey` is a prefix of `veyyon`, which appears on nearly every line.
		expect(scriptBindsAlias("complete -F _veyyon veyyon", "vey")).toBe(false);
		expect(scriptBindsAlias("#compdef veyyon", "vey")).toBe(false);
		expect(scriptBindsAlias("_veyyon_cmd_config() {", "vey")).toBe(false);
	});

	it("does not match the alias inside a longer hyphenated or dotted word", () => {
		// `veyyon-completions.ps1` and `vey.old` are not bindings.
		expect(scriptBindsAlias(". 'C:\\Users\\me\\vey-completions.ps1'", "vey")).toBe(false);
		expect(scriptBindsAlias("source ~/vey.bak", "vey")).toBe(false);
	});
});
