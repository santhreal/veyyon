/**
 * The destructive-command guard, stated as the shapes that have actually
 * destroyed somebody's home directory.
 *
 * WHY THIS SUITE EXISTS. `FLAGGED_BASH_PATTERNS` had no test of any kind, and
 * measured against it directly, it flagged exactly one of the twelve deletion
 * shapes below. The eleven it missed include all three published incidents:
 *
 *   Claude CLI, December 2025      `rm -rf tests/patches/plan/ ~/`
 *   Claude Cowork, January 2026    a delete chosen over the trash, 15 years of photos
 *   GPT-5.6-Sol, July 2026         `$HOME` expanded after the check passed
 *
 * The common mechanism is that the guard reads the command as TEXT and the
 * damage happens at EXPANSION time. `bash-guard.ts` is the answer to that, and
 * every shape below is a named case here so the next rewrite of the guard
 * cannot quietly lose one.
 *
 * The second half of the suite is as load-bearing as the first: a guard that
 * refuses ordinary work gets turned off, and a guard that is off protects
 * nobody. Every workspace-relative delete an agent does all day must pass
 * without a prompt.
 */

import { describe, expect, it } from "bun:test";
import { bashApprovalDecision } from "../src/tools/bash";
import {
	expandWord,
	FLAGGED_BASH_PATTERNS,
	findCriticalBashRisk,
	findFlaggedBashPattern,
	judgeDeleteTarget,
	normalizeAbsolutePath,
	resolveGuardHome,
	splitCommandSegments,
	splitWords,
} from "../src/tools/bash-guard";

/** A stable home directory, so the rule is stated independently of the machine. */
const HOME = "/home/agent";

/** The guard's verdict for a command, as a plain boolean. */
const refuses = (command: string, home = HOME): boolean => findCriticalBashRisk(command, home) !== undefined;

describe("the shapes that have destroyed a home directory", () => {
	/**
	 * The one shape the old text-matching guard caught. It is here so a rewrite
	 * that fixes the other eleven cannot lose the one that already worked.
	 */
	it("refuses a recursive delete of the literal root", () => {
		expect(refuses("rm -rf /")).toBe(true);
	});

	/**
	 * The tilde is the single most common way to name the home directory and the
	 * old guard did not expand it, so `rm -rf ~/` read as an ordinary relative
	 * path. This is the December 2025 incident's target.
	 */
	it("refuses a recursive delete of the tilde, with and without a trailing slash", () => {
		expect(refuses("rm -rf ~/")).toBe(true);
		expect(refuses("rm -rf ~")).toBe(true);
	});

	/**
	 * `$HOME` is the other spelling, and the July 2026 incident is exactly this:
	 * the variable expanded after the validation had already passed.
	 */
	it("refuses a recursive delete of $HOME in every spelling", () => {
		expect(refuses("rm -rf $HOME")).toBe(true);
		expect(refuses('rm -rf "$HOME"/')).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
		expect(refuses("rm -rf ${HOME}")).toBe(true);
	});

	/**
	 * A protected directory under the home is not recoverable by reinstalling
	 * anything, so it is refused on its own rather than only as part of a delete
	 * of the whole home.
	 */
	it("refuses a recursive delete of the directories that hold credentials", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
		expect(refuses("rm -rf ${HOME}/.config")).toBe(true);
		expect(refuses("rm -rf ~/.ssh")).toBe(true);
		expect(refuses("rm -rf ~/.gnupg")).toBe(true);
	});

	/**
	 * A credentials directory is protected all the way down: one key file is as
	 * unrecoverable as the whole directory, and neither is regenerable from a
	 * lockfile.
	 */
	it("refuses a delete of a single file inside a credentials directory", () => {
		expect(refuses("rm -rf ~/.aws/credentials")).toBe(true);
		expect(refuses("rm -rf ~/.ssh/id_ed25519")).toBe(true);
		expect(refuses("rm -rf ~/.config/gcloud/creds.db")).toBe(true);
	});

	/**
	 * THE other side of that split, and the reason it is a split rather than one
	 * list. `~/.config` as a whole is virtually never what was meant, while
	 * `~/.config/some-app` is a normal cleanup. A guard that refuses the second
	 * gets a reputation for crying wolf, and a guard with that reputation gets
	 * switched off.
	 */
	it("allows a delete inside a protected directory that is not a credentials store", () => {
		expect(refuses("rm -rf ~/.config/some-app")).toBe(false);
		expect(refuses("rm -rf ~/.cache/turbo")).toBe(false);
		expect(refuses("rm -rf ~/.local/share/some-app")).toBe(false);
	});

	/**
	 * THE December 2025 command, whole. The dangerous target is the SECOND one,
	 * and the old pattern anchored the slash immediately after the flags, which
	 * made it a first-argument check presented as a command check.
	 */
	it("refuses the December 2025 command, whose dangerous target is not the first", () => {
		expect(refuses("rm -rf tests/patches/plan/ ~/")).toBe(true);
	});

	/**
	 * The same positional blindness with a literal root rather than a tilde, which
	 * is the sharpest possible demonstration: the guard's own pattern names this
	 * exact path and still missed it because it was not in argument one.
	 */
	it("refuses a literal root that is not the first target", () => {
		expect(refuses("rm -rf tests/ /")).toBe(true);
	});

	/**
	 * The empty-expansion shape, which has no safe reading: if `dir` is empty the
	 * command starts at the root, and nothing in the command text says whether it
	 * is. The guard fails closed here, and the cost of being wrong is one prompt.
	 */
	it("refuses a recursive delete whose target it cannot resolve", () => {
		expect(refuses('rm -rf "$dir"/*')).toBe(true);
		expect(refuses("rm -rf $UNSET_VAR/lib")).toBe(true);
		expect(refuses("rm -rf $(cat target.txt)")).toBe(true);
		expect(refuses("rm -rf `cat target.txt`")).toBe(true);
	});

	/**
	 * Not every recursive delete is spelled `rm`. `find ~ -delete` removes the
	 * same tree and contains none of the tokens the old patterns looked for.
	 */
	it("refuses a find that deletes, which never says rm at all", () => {
		expect(refuses("find ~ -delete")).toBe(true);
		expect(refuses("find / -name '*.log' -delete")).toBe(true);
		expect(refuses("find ~/.ssh -exec rm {} ;")).toBe(true);
		expect(refuses("find ~ -execdir shred {} ;")).toBe(true);
	});

	/**
	 * `-exec` on its own says nothing about danger: what matters is the command
	 * it runs. `find ~ -exec ls {} \;` is a listing, and a guard that prompted
	 * on it would prompt on ordinary search work, which is how a guard earns a
	 * reputation for crying wolf.
	 */
	it("allows a find whose -exec runs something harmless", () => {
		expect(refuses("find ~ -exec ls {} ;")).toBe(false);
		expect(refuses("find ~/.ssh -exec cat {} ;")).toBe(false);
		expect(refuses("find / -name '*.ts' -exec grep -l foo {} ;")).toBe(false);
	});
});

describe("the twelve shapes as one table", () => {
	/**
	 * The whole finding in one assertion, so a regression shows up as a list of
	 * what stopped being refused rather than as one opaque failure. The old
	 * guard scored 1/12 here.
	 */
	it("refuses every one of them", () => {
		const shapes = [
			"rm -rf /",
			"rm -rf ~/",
			"rm -rf ~",
			"rm -rf $HOME",
			'rm -rf "$HOME"/',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
			"rm -rf ${HOME}/.config",
			"rm -rf tests/patches/plan/ ~/",
			"rm -rf tests/ /",
			'rm -rf "$dir"/*',
			"find ~ -delete",
			"rm -rf ~/.ssh",
			"rm -fr /etc",
		];

		const missed = shapes.filter(shape => !refuses(shape));

		expect(missed).toEqual([]);
	});
});

describe("the ordinary work an agent does all day", () => {
	/**
	 * A guard that refuses these gets turned off, and a guard that is off
	 * protects nobody. Every one of these is a delete an agent performs
	 * routinely inside its workspace.
	 */
	it("allows relative deletes inside the workspace", () => {
		expect(refuses("rm -rf node_modules")).toBe(false);
		expect(refuses("rm -rf dist build .cache")).toBe(false);
		expect(refuses("rm -rf ./target/debug")).toBe(false);
		expect(refuses("rm -f package-lock.json")).toBe(false);
		expect(refuses("rm -rf packages/*/node_modules")).toBe(false);
	});

	/**
	 * An absolute path that is neither protected nor an ancestor of anything
	 * protected is ordinary too. A guard keyed on "absolute means dangerous"
	 * would refuse every temp-directory cleanup in the suite.
	 */
	it("allows an absolute delete that threatens nothing protected", () => {
		expect(refuses("rm -rf /tmp/veyyon-build-1234")).toBe(false);
		expect(refuses("rm -rf /home/agent/projects/veyyon/dist")).toBe(false);
	});

	/** A non-recursive delete of one file is not the shape this guard is about. */
	it("allows a single-file delete even of an absolute path", () => {
		expect(refuses("rm /home/agent/projects/x/out.log")).toBe(false);
	});

	/**
	 * A command that merely MENTIONS a protected path is not a delete of it.
	 * This is the false-positive that a text-matching guard produces most often
	 * and the reason the guard parses rather than greps.
	 */
	it("allows reading, listing and grepping a protected path", () => {
		expect(refuses("ls -la ~/.ssh")).toBe(false);
		expect(refuses("cat ~/.aws/config")).toBe(false);
		expect(refuses("grep -r 'rm -rf /' docs/")).toBe(false);
		expect(refuses("echo 'do not run rm -rf ~/'")).toBe(false);
	});

	/**
	 * A tilde inside single quotes is a directory actually named `~`, not the
	 * home directory, because the shell does not expand there. Getting this
	 * wrong in the other direction would be a false positive on a real path.
	 */
	it("does not expand a tilde the shell would not expand", () => {
		expect(refuses("rm -rf './~'")).toBe(false);
	});
});

describe("the commands the guard reaches through", () => {
	/**
	 * `sudo rm -rf ~` is strictly worse than the unprefixed form, so the guard
	 * has to look past the wrapper rather than judge `sudo` as the command.
	 */
	it("looks past sudo, env and nice to the real command", () => {
		expect(refuses("sudo rm -rf ~/")).toBe(true);
		expect(refuses("env FOO=bar rm -rf /")).toBe(true);
		expect(refuses("nice rm -rf $HOME")).toBe(true);
		expect(refuses("FOO=bar rm -rf /etc")).toBe(true);
	});

	/**
	 * A dangerous command in the second half of a chain is exactly as dangerous.
	 * A guard that only reads the first command is a guard an agent walks around
	 * by accident.
	 */
	it("judges every command in a chain, not only the first", () => {
		expect(refuses("cd /tmp && rm -rf ~/")).toBe(true);
		expect(refuses("npm test; rm -rf $HOME")).toBe(true);
		expect(refuses("make || rm -rf /etc")).toBe(true);
		expect(refuses("echo start | xargs true && rm -rf ~")).toBe(true);
	});

	/** An absolute path to the binary is the same binary. */
	it("judges /bin/rm as rm", () => {
		expect(refuses("/bin/rm -rf ~/")).toBe(true);
	});

	/**
	 * A recursive permission change on a protected tree is as destructive as a
	 * delete: `chmod -R 777 ~` is unrecoverable in every way that matters.
	 */
	it("refuses a recursive rewrite of a protected tree", () => {
		expect(refuses("chmod -R 777 ~")).toBe(true);
		expect(refuses("chown -R nobody /etc")).toBe(true);
	});

	/**
	 * The recursion flag is what makes a delete a tree delete, so a delete
	 * without it is not this guard's business even against a protected path: the
	 * kernel refuses to unlink a directory without `-r` anyway.
	 */
	it("does not treat a non-recursive rm as a tree delete", () => {
		expect(refuses("rm -f ~/.ssh/known_hosts")).toBe(false);
		expect(refuses("rm ~/notes.txt")).toBe(false);
	});

	/**
	 * Every judgement used to read `argv[0]`, so anything standing where the
	 * command word goes hid the delete outright rather than weakening the rule.
	 * `for i in 1 ; do rm -rf / ; done` was not critical, which in yolo means it
	 * ran with no prompt, and a loop is the most natural way to write a cleanup,
	 * so reaching it took no intent. The fix scans every word position, so this
	 * case list is a sample of a general rule and not the rule itself.
	 */
	it("finds the delete wherever in the line it stands", () => {
		expect(refuses("for i in 1 ; do rm -rf / ; done")).toBe(true);
		expect(refuses("for i in 1 ; do for j in 2 ; do rm -rf / ; done ; done")).toBe(true);
		expect(refuses("if true ; then rm -rf ~/.ssh ; fi")).toBe(true);
		expect(refuses("while true ; do rm -rf ~ ; done")).toBe(true);
		expect(refuses("until false ; do rm -rf ~ ; done")).toBe(true);
		expect(refuses("true && { rm -rf /etc ; }")).toBe(true);
		expect(refuses("x() { rm -rf ~/ ; } ; x")).toBe(true);
		expect(refuses("(rm -rf /)")).toBe(true);
		expect(refuses("rm -rf / &")).toBe(true);
		expect(refuses("case x in x) rm -rf / ;; esac")).toBe(true);
		expect(refuses("time rm -rf /")).toBe(true);
		expect(refuses("! rm -rf ~/")).toBe(true);
		expect(refuses("command rm -rf /")).toBe(true);
		expect(refuses("xargs rm -rf ~/")).toBe(true);
	});

	/** The dangerous statement is rarely the last thing on the line, and a
	 * newline separates two commands exactly as a semicolon does. */
	it("keeps looking after the first harmless statement", () => {
		expect(refuses("if true ; then echo skip ; else rm -rf ~/ ; fi")).toBe(true);
		expect(refuses("echo one\nrm -rf ~/\necho two")).toBe(true);
		expect(refuses("npm run build && rm -rf ~/ && echo done")).toBe(true);
	});

	/**
	 * A script argument is shell text and has to be read as shell text. All five
	 * of these were allowed. The delete inside a command substitution is the one
	 * the reading cannot reach, because the whole `$(…)` is a single word to the
	 * splitter, so it is refused on the raw text instead.
	 */
	it("reads the script a command hands to a shell", () => {
		expect(refuses('eval "rm -rf ~/"')).toBe(true);
		expect(refuses('bash -c "rm -rf ~/"')).toBe(true);
		expect(refuses("sh -lc 'rm -rf ~'")).toBe(true);
		expect(refuses("bash -c \"sh -c 'rm -rf ~/'\"")).toBe(true);
		expect(refuses('trap "rm -rf ~/" EXIT')).toBe(true);
		expect(refuses('eval "$(rm -rf /)"')).toBe(true);
	});

	/** Scanning every position must not start refusing what an agent writes all
	 * day, and text that merely QUOTES a dangerous command is not one. */
	it("still allows the ordinary shapes", () => {
		expect(refuses("if true ; then rm -rf ./node_modules ; fi")).toBe(false);
		expect(refuses("for d in build dist ; do rm -rf ./build ; done")).toBe(false);
		expect(refuses('bash -c "npm run build"')).toBe(false);
		expect(refuses('sh -c "rm -rf ./dist"')).toBe(false);
		expect(refuses('trap "echo bye" EXIT')).toBe(false);
		expect(refuses('echo "rm -rf ~/"')).toBe(false);
	});
});

describe("the operator's own protected paths", () => {
	/** The guard's verdict with extra configured paths. */
	const refusesWith = (command: string, extra: string[]): boolean =>
		findCriticalBashRisk(command, HOME, extra) !== undefined;

	/**
	 * The reason this setting exists: the built-in list cannot know about a NAS
	 * mount, a photo library, or a scratch volume that would take a week to
	 * rebuild.
	 */
	it("refuses a configured path", () => {
		expect(refusesWith("rm -rf /mnt/photos", ["/mnt/photos"])).toBe(true);
		expect(refusesWith("rm -rf /mnt/photos/2019", ["/mnt/photos"])).toBe(true);
		expect(refusesWith("rm -rf /mnt", ["/mnt/photos"])).toBe(true);
	});

	/** A `~` entry is how an operator writes a home-relative path in a config. */
	it("expands a leading tilde in a configured path", () => {
		expect(refusesWith("rm -rf ~/Documents", ["~/Documents"])).toBe(true);
		expect(refusesWith(`rm -rf ${HOME}/Documents/taxes`, ["~/Documents"])).toBe(true);
	});

	/**
	 * THE property that makes this setting safe to expose at all: it can only
	 * ADD. Nothing in the built-in judgement consults config, so no configured
	 * value, however written, can stop the guard refusing the home directory.
	 * A setting that could shrink a safety floor is a setting an agent can be
	 * talked into editing.
	 */
	it("cannot remove anything from the built-in set", () => {
		for (const attempt of [[], ["/tmp"], ["!~"], ["-/"], [""], ["  "]]) {
			expect(refusesWith("rm -rf ~/", attempt)).toBe(true);
			expect(refusesWith("rm -rf /", attempt)).toBe(true);
			expect(refusesWith("rm -rf ~/.ssh", attempt)).toBe(true);
		}
	});

	/**
	 * A relative entry is ignored rather than resolved against a guessed working
	 * directory, because guessing would protect a different place than the one
	 * the operator wrote down, and they would never learn it.
	 */
	it("ignores an entry that does not name an absolute path", () => {
		expect(refusesWith("rm -rf build", ["build"])).toBe(false);
		expect(refusesWith("rm -rf ./build", ["./build"])).toBe(false);
		expect(refusesWith("rm -rf node_modules", [""])).toBe(false);
	});

	/** Configured paths do not disturb ordinary work outside them. */
	it("leaves everything else alone", () => {
		expect(refusesWith("rm -rf node_modules", ["/mnt/photos"])).toBe(false);
		expect(refusesWith("rm -rf /tmp/build", ["/mnt/photos"])).toBe(false);
	});

	/**
	 * The reason names the setting, so an operator who is surprised by the
	 * prompt can find the line that caused it instead of assuming the guard is
	 * broken.
	 */
	it("says which setting caused the refusal", () => {
		const risk = findCriticalBashRisk("rm -rf /mnt/photos", HOME, ["/mnt/photos"]);

		expect(risk!.reason).toContain("tools.protectedPaths");
		expect(risk!.reason).toContain("/mnt/photos");
	});

	/**
	 * A built-in reason is never replaced by the vaguer configured one, so the
	 * prompt still says "the home directory itself" when that is what it is.
	 */
	it("prefers the built-in reason when both apply", () => {
		const risk = findCriticalBashRisk("rm -rf ~/", HOME, ["~"]);

		expect(risk!.reason).toBe("rm would recursively remove the home directory itself");
	});
});

describe("a redirect that overwrites a key", () => {
	/**
	 * `> ~/.ssh/id_ed25519` destroys a private key exactly as thoroughly as `rm`
	 * does, and it contains no delete command at all, so nothing in the deletion
	 * rules sees it. Same incident class, different verb.
	 */
	it("refuses a truncating redirect into a credentials directory", () => {
		expect(refuses("echo x > ~/.ssh/id_ed25519")).toBe(true);
		expect(refuses("cat /dev/null > ~/.aws/credentials")).toBe(true);
		expect(refuses("ssh-keygen -y > $HOME/.gnupg/secring.gpg")).toBe(true);
	});

	/** The redirect operator does not need a space after it. */
	it("reads a redirect written without a space", () => {
		expect(refuses("echo x >~/.ssh/config")).toBe(true);
		expect(refuses("echo x 1>~/.ssh/config")).toBe(true);
	});

	/**
	 * Appending does not destroy what is already there, which is the whole
	 * difference. `>>` is how you legitimately add a key to `authorized_keys`,
	 * and refusing it would break an ordinary workflow to prevent nothing.
	 */
	it("allows an appending redirect", () => {
		expect(refuses("echo key >> ~/.ssh/authorized_keys")).toBe(false);
	});

	/**
	 * The rule is narrow on purpose. Writing files is what an agent does all
	 * day, so only the credentials directories are covered here; a broad
	 * "redirects are dangerous" rule would prompt constantly and get switched
	 * off.
	 */
	it("allows an ordinary redirect anywhere else", () => {
		expect(refuses("echo x > out.log")).toBe(false);
		expect(refuses("bun test > /tmp/results.txt")).toBe(false);
		expect(refuses("echo x > ~/.config/some-app/settings.json")).toBe(false);
		expect(refuses("echo x > ~/notes.md")).toBe(false);
	});

	/** And it names what would have been overwritten. */
	it("names the file it would have overwritten", () => {
		const risk = findCriticalBashRisk("echo x > ~/.ssh/id_ed25519", HOME);

		expect(risk).toBeDefined();
		expect(risk!.command).toBe("redirect");
		expect(risk!.target).toBe(`${HOME}/.ssh/id_ed25519`);
	});
});

describe("the same command spelled differently", () => {
	/**
	 * The recursion flag has several spellings and the guard must read all of
	 * them, because an agent picks whichever one it learned. A guard that only
	 * knows `-rf` is a guard that misses `rm -r -f`.
	 */
	it("reads every spelling of the recursion flag", () => {
		for (const flags of ["-rf", "-fr", "-r -f", "-f -r", "--recursive --force", "-R", "-rvf"]) {
			expect(refuses(`rm ${flags} ~/`)).toBe(true);
		}
	});

	/**
	 * A path can be written many ways and still name the home directory. The
	 * normalizer is what makes these one question rather than seven.
	 */
	it("reads every spelling of the same path", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
		for (const path of ["~", "~/", "~//", "~/.", "~/./", "$HOME", "${HOME}", '"$HOME"', "~/../agent"]) {
			expect(refuses(`rm -rf ${path}`)).toBe(true);
		}
	});

	/**
	 * A leading backslash is how a shell user bypasses an alias, and it does not
	 * change which binary runs. The guard unescapes before it reads the command
	 * word.
	 */
	it("reads a backslash-escaped command name", () => {
		expect(refuses("\\rm -rf ~/")).toBe(true);
	});

	/**
	 * `--` ends the flags and everything after it is a target. A guard that
	 * treated `--` as just another flag would be fine here, but one that stopped
	 * reading targets at `--` would miss the only one that matters.
	 */
	it("keeps reading targets after the end-of-flags marker", () => {
		expect(refuses("rm -rf -- ~/")).toBe(true);
	});

	/**
	 * A DELIBERATE over-refusal, documented so nobody "fixes" it. Bash does not
	 * expand a tilde inside double quotes, so `rm -rf "~"` really does mean a
	 * directory named `~`. The guard expands it anyway, because the shapes are
	 * indistinguishable to a reader glancing at a prompt and the cost of being
	 * wrong in this direction is one approval.
	 */
	it("over-refuses a double-quoted tilde on purpose", () => {
		expect(refuses('rm -rf "~"')).toBe(true);
	});

	/** Extra whitespace between words changes nothing. */
	it("reads a command padded with whitespace", () => {
		expect(refuses("   rm   -rf    ~/   ")).toBe(true);
		expect(refuses("rm\t-rf\t~/")).toBe(true);
	});

	/** A newline separates commands exactly as a semicolon does. */
	it("judges a command on its own line", () => {
		expect(refuses("cd /tmp\nrm -rf ~/")).toBe(true);
	});

	/**
	 * A subshell is still a command, and a guard that stopped at the opening
	 * parenthesis would read `rm -rf ~` as belonging to nothing.
	 */
	it("judges a command inside a subshell", () => {
		expect(refuses("(cd /tmp && rm -rf ~/)")).toBe(true);
	});

	/**
	 * A nested command substitution is one word, not a nest of segments. The
	 * outer `$(` has to find ITS closing parenthesis, not the first one.
	 */
	it("treats a nested command substitution as one unresolvable word", () => {
		expect(refuses("rm -rf $(dirname $(pwd))")).toBe(true);
	});

	/**
	 * An unbalanced substitution is a syntax error to the shell. The guard reads
	 * it as one unresolvable word rather than as a split, because splitting
	 * there is how `rm -rf $` became the whole command.
	 */
	it("does not split on an unbalanced command substitution", () => {
		expect(refuses("rm -rf $(cat missing")).toBe(true);
	});
});

describe("splitting a command line", () => {
	/** The separators that end one command and begin another. */
	it("splits on every unquoted separator", () => {
		expect(splitCommandSegments("a && b; c | d")).toEqual(["a", "b", "c", "d"]);
	});

	/**
	 * A separator inside quotes belongs to the argument, not to the shell. This
	 * is what keeps `echo "a; rm -rf /"` from being read as two commands, and
	 * more importantly keeps a real argument from being cut in half.
	 */
	it("leaves a quoted separator inside its word", () => {
		expect(splitCommandSegments('echo "a; b"')).toEqual(['echo "a; b"']);
		expect(splitCommandSegments("echo 'a && b'")).toEqual(["echo 'a && b'"]);
	});

	/** An escaped separator is likewise not a separator. */
	it("leaves an escaped separator inside its word", () => {
		expect(splitCommandSegments("echo a\\;b")).toEqual(["echo a\\;b"]);
	});
});

describe("splitting a segment into words", () => {
	/** Quotes group, and are removed once they have done their grouping. */
	it("keeps a quoted run together and drops the quotes", () => {
		expect(splitWords('rm -rf "my dir"')).toEqual([
			{ text: "rm", literal: false },
			{ text: "-rf", literal: false },
			{ text: "my dir", literal: false },
		]);
	});

	/**
	 * A single-quoted word is marked literal, because that is what tells the
	 * expander that `'$HOME'` is a directory name rather than the home
	 * directory.
	 */
	it("marks a single-quoted word as literal", () => {
		expect(splitWords("rm '$HOME'")[1]).toEqual({ text: "$HOME", literal: true });
	});

	/** An empty quoted word is still a word, which is the `""` argument case. */
	it("keeps an empty quoted word", () => {
		expect(splitWords('rm ""')).toEqual([
			{ text: "rm", literal: false },
			{ text: "", literal: false },
		]);
	});
});

describe("expanding a word", () => {
	/** The two spellings of the home directory that the guard can be sure of. */
	it("expands a leading tilde and $HOME", () => {
		expect(expandWord({ text: "~", literal: false }, HOME).text).toBe(HOME);
		expect(expandWord({ text: "~/.ssh", literal: false }, HOME).text).toBe(`${HOME}/.ssh`);
		expect(expandWord({ text: "$HOME/x", literal: false }, HOME).text).toBe(`${HOME}/x`);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
		expect(expandWord({ text: "${HOME}/x", literal: false }, HOME).text).toBe(`${HOME}/x`);
	});

	/**
	 * A tilde that is not at the start is a literal tilde, which is what the
	 * shell does and what keeps `rm -rf ./a~b` from being read as a home-relative
	 * path.
	 */
	it("does not expand a tilde that is not at the start", () => {
		expect(expandWord({ text: "./a~b", literal: false }, HOME).text).toBe("./a~b");
	});

	/**
	 * Anything else is reported as unknown rather than guessed at, and unknown
	 * is what the delete rule fails closed on.
	 */
	it("reports an expansion it cannot resolve as unknown", () => {
		expect(expandWord({ text: "$dir/x", literal: false }, HOME).unknown).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
		expect(expandWord({ text: "${dir}/x", literal: false }, HOME).unknown).toBe(true);
		expect(expandWord({ text: "$(pwd)", literal: false }, HOME).unknown).toBe(true);
		expect(expandWord({ text: "~otheruser/x", literal: false }, HOME).unknown).toBe(true);
	});

	/** A literal word holds no expansions by definition. */
	it("expands nothing in a single-quoted word", () => {
		const expanded = expandWord({ text: "$HOME", literal: true }, HOME);
		expect(expanded.text).toBe("$HOME");
		expect(expanded.unknown).toBe(false);
	});
});

describe("finding out where home is", () => {
	/**
	 * `process.env.HOME` comes first because the command runs in a shell that
	 * inherits this environment, so the environment variable is what `~` will
	 * expand to. `os.homedir()` reads the passwd entry and, in Bun, is fixed at
	 * process start: assigning `process.env.HOME` does not move it. The repo
	 * already carries a tripwire about that exact trap, and judging `rm -rf ~`
	 * against a different directory than the shell will delete is the failure
	 * this whole module exists to prevent.
	 */
	it("prefers the environment the shell will actually see", () => {
		expect(resolveGuardHome({ HOME: "/home/from-env" } as NodeJS.ProcessEnv)).toBe("/home/from-env");
	});

	/** Windows names it differently and the guard reads that too. */
	it("falls back to USERPROFILE", () => {
		expect(resolveGuardHome({ USERPROFILE: "/Users/agent" } as NodeJS.ProcessEnv)).toBe("/Users/agent");
	});

	/**
	 * A relative or empty value is not an answer. Accepting one would make every
	 * home comparison compare against nonsense.
	 */
	it("rejects a value that is not an absolute path", () => {
		expect(resolveGuardHome({ HOME: "", USERPROFILE: "relative/path" } as NodeJS.ProcessEnv)).not.toBe("");
		expect(resolveGuardHome({ HOME: "relative", USERPROFILE: "" } as NodeJS.ProcessEnv)).not.toBe("relative");
	});

	/**
	 * THE fail-closed rule, and the reason it is a rule rather than a fallback.
	 * With no home to resolve, substituting an empty string turns `rm -rf ~`
	 * into `rm -rf ` and the guard waves through the single most dangerous
	 * command it exists to catch, quietly and while appearing to work. An
	 * unknown home makes the word unresolvable, and unresolvable is refused.
	 */
	it("refuses a tilde it cannot resolve rather than expanding it to nothing", () => {
		expect(refuses("rm -rf ~", "")).toBe(true);
		expect(refuses("rm -rf ~/", "")).toBe(true);
		expect(refuses("rm -rf $HOME", "")).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the shell spelling under test, not a template literal.
		expect(refuses("rm -rf ${HOME}/.config", "")).toBe(true);
	});

	/** And says so, rather than reporting a path it did not resolve. */
	it("reports the unresolvable home as unknown", () => {
		const expanded = expandWord({ text: "~", literal: false }, "");

		expect(expanded.unknown).toBe(true);
		expect(expanded.emptied).toBe(true);
	});

	/**
	 * The two unresolvable kinds read differently in the prompt, because they
	 * ask the operator different questions. "I do not know where your home is"
	 * is a host misconfiguration; "the value that makes `$dir` dangerous is the
	 * empty one" names the reading the refusal is about, which is the thing an
	 * operator can act on.
	 */
	it("distinguishes an unlocatable home from an unevaluated variable", () => {
		expect(findCriticalBashRisk("rm -rf ~", "")!.reason).toContain("cannot locate");
		expect(findCriticalBashRisk('rm -rf "$dir"/*', HOME)!.reason).toBe(
			"rm would recursively remove a protected system directory (/) when the expansion this command line does not settle is empty",
		);
	});

	/**
	 * Ordinary work is still allowed with no home, because a relative delete
	 * never depended on knowing where home was. A fail-closed rule that also
	 * refused `rm -rf node_modules` would be unusable on such a host.
	 */
	it("still allows a relative delete with no home to resolve", () => {
		expect(refuses("rm -rf node_modules", "")).toBe(false);
		expect(refuses("rm -rf /tmp/build", "")).toBe(false);
	});

	/** A protected system root does not need a home to be judged. */
	it("still refuses the system roots with no home to resolve", () => {
		expect(refuses("rm -rf /", "")).toBe(true);
		expect(refuses("rm -rf /etc", "")).toBe(true);
	});
});

describe("normalizing a path before it is judged", () => {
	/**
	 * `..` is resolved lexically rather than on disk, because the guard has to
	 * answer before anything runs and the shell will walk it the same way.
	 */
	it("resolves dot-dot lexically", () => {
		expect(normalizeAbsolutePath("/home/agent/projects/../..")).toBe("/home");
		expect(normalizeAbsolutePath("/a/b/../../..")).toBe("/");
	});

	/** Repeated and trailing separators do not change which directory is named. */
	it("collapses repeated and trailing separators", () => {
		expect(normalizeAbsolutePath("//home//agent//")).toBe("/home/agent");
		expect(normalizeAbsolutePath("/")).toBe("/");
		expect(normalizeAbsolutePath("/./home/./agent")).toBe("/home/agent");
	});

	/**
	 * THE case a lexical normalizer exists for: a relative-looking walk out of
	 * the workspace lands on the home directory and must be judged as such.
	 */
	it("is what catches a walk out of the workspace", () => {
		expect(refuses("rm -rf /home/agent/projects/veyyon/../../../agent")).toBe(true);
	});
});

describe("judging one target", () => {
	/** The home directory itself, named directly. */
	it("refuses the home directory", () => {
		expect(judgeDeleteTarget({ text: HOME, unknown: false, emptied: false }, HOME)).toContain(
			"the home directory itself",
		);
	});

	/**
	 * An ANCESTOR of the home directory takes the home with it, so `/home` is
	 * refused even though it is not in the protected-root list.
	 */
	it("refuses an ancestor of the home directory", () => {
		expect(judgeDeleteTarget({ text: "/home", unknown: false, emptied: false }, HOME)).toContain(
			"an ancestor of the home directory",
		);
	});

	/**
	 * The reason an operator reads is the most specific one available. `/` is
	 * both a system root and an ancestor of the home directory, and describing
	 * a delete of the entire filesystem as "an ancestor of the home directory"
	 * buries what is actually about to happen.
	 */
	it("describes the root as a system directory rather than as an ancestor", () => {
		expect(judgeDeleteTarget({ text: "/", unknown: false, emptied: false }, HOME)).toBe(
			"a protected system directory (/)",
		);
	});

	/** A relative path is never judged, whatever it is named. */
	it("allows any relative path", () => {
		expect(judgeDeleteTarget({ text: "node_modules", unknown: false, emptied: false }, HOME)).toBeUndefined();
		expect(judgeDeleteTarget({ text: "./home", unknown: false, emptied: false }, HOME)).toBeUndefined();
	});

	/**
	 * An unsettled expansion is judged by what it can become: `$dir/x` is
	 * `/x` at worst, which the literal spelling `rm -rf /x` is also allowed to
	 * delete, while `$dir` alone is the root and `$dir/lib` is a protected root.
	 */
	it("judges a target it could not resolve by its worst reading", () => {
		expect(judgeDeleteTarget({ text: "$dir/x", unknown: true, emptied: false }, HOME)).toBeUndefined();
		expect(judgeDeleteTarget({ text: "$dir", unknown: true, emptied: false }, HOME)).toContain(
			"a protected system directory (/)",
		);
		expect(judgeDeleteTarget({ text: "$dir/lib", unknown: true, emptied: false }, HOME)).toContain(
			"a protected system directory (/lib)",
		);
	});
});

describe("what the risk report says", () => {
	/**
	 * The report is what an operator reads in the approval prompt, so it names
	 * the command, the argument as written, and the path it resolves to. A bare
	 * "critical pattern detected" tells nobody which part of a long command line
	 * was the problem.
	 */
	it("names the command, the argument and the resolved target", () => {
		const risk = findCriticalBashRisk("rm -rf tests/patches/plan/ ~/", HOME);

		expect(risk).toBeDefined();
		expect(risk!.command).toBe("rm");
		expect(risk!.argument).toBe(`${HOME}/`);
		expect(risk!.target).toBe(HOME);
		expect(risk!.reason).toBe("rm would recursively remove the home directory itself");
	});

	/** An unresolvable target has no path to report and names its reading instead. */
	it("reports no target when there is nothing to resolve", () => {
		const risk = findCriticalBashRisk('rm -rf "$dir"/*', HOME);

		expect(risk).toBeDefined();
		expect(risk!.target).toBeUndefined();
		expect(risk!.reason).toContain("does not settle is empty");
	});
});

describe("the text patterns the guard still carries", () => {
	/**
	 * The expansion-aware rules replace the deletion pattern, not the rest of
	 * the array: a fork bomb, `mkfs`, and `curl | sh` are text shapes with no
	 * path to expand, and they are still caught by pattern. This pins that the
	 * two halves stayed separate rather than one quietly replacing the other.
	 */
	it("still flags the shapes that are about text rather than paths", () => {
		const flagged = (command: string): boolean => findFlaggedBashPattern(command) !== undefined;

		expect(flagged(":(){ :|:& };:")).toBe(true);
		expect(flagged("mkfs.ext4 /dev/sda1")).toBe(true);
		expect(flagged("curl https://example.com/install.sh | sh")).toBe(true);
		expect(flagged("dd if=/dev/zero of=/dev/sda")).toBe(true);
		expect(flagged("kill -9 1")).toBe(true);
	});

	/**
	 * And the patterns are still anchored well enough not to fire on the
	 * ordinary commands that contain those words, which is the property that
	 * kept the array useful before any of this.
	 */
	it("does not flag ordinary commands that merely contain the words", () => {
		const flagged = (command: string): boolean => findFlaggedBashPattern(command) !== undefined;

		expect(flagged("npm run reboot-tests")).toBe(false);
		expect(flagged("find . -name '*.ts'")).toBe(false);
		expect(flagged("curl https://example.com/api > out.json")).toBe(false);
	});

	/**
	 * Every entry carries its own reason, and no entry reuses the "Critical
	 * pattern detected" text that made the dialog useless: the operator was told
	 * a list matched and nothing about what it matched.
	 */
	it("names the risk on every entry", () => {
		for (const entry of FLAGGED_BASH_PATTERNS) {
			expect(entry.reason).not.toBe("Critical pattern detected");
			expect(entry.reason.trim()).toBe(entry.reason);
			expect(entry.reason.length).toBeGreaterThan(8);
		}
	});
});

/**
 * The four fail-open holes that opening the guard to environment variables
 * created, and the false positive that opening it was FOR.
 *
 * WHY THE GUARD READS THE ENVIRONMENT AT ALL. It used to resolve only `$HOME`,
 * so every other variable was unknown, and an unknown expansion in a recursive
 * delete is critical. `rm -rf $TMPDIR/scratch` therefore prompted in yolo, which
 * is a mode whose whole promise is that it does not. A guard that cries wolf on
 * `$TMPDIR` is one people switch off before it ever sees a real wolf.
 *
 * WHY THAT IS DANGEROUS IF DONE NAIVELY. Substituting a variable's value into
 * one word is not what a shell does, and each gap below was measured running
 * `rm -rf /` with no prompt at any rung, including the `critical` floor that is
 * the last thing standing in yolo:
 *
 *   1. the bash tool's own `env` argument reaches the CHILD but was not read by
 *      the guard, so the caller supplied one value to each;
 *   2. an inline `VAR=value` assignment binds for the command but was skipped;
 *   3. a value containing a space or a glob word-splits or expands in the shell
 *      and does not in the guard;
 *   4. `${VAR:-/}` and its operator siblings matched no expansion pattern at
 *      all, so they were judged as their own literal text (this one predates
 *      the change and was found alongside it).
 *
 * Every case is driven through `bashApprovalDecision`, the entry point the tool
 * actually calls, because the first hole was invisible to a test that called
 * `findCriticalBashRisk` directly with no environment.
 */
describe("expansion the shell will perform, judged the way the shell will perform it", () => {
	const verdict = (args: { command: string; env?: Record<string, string> }): "critical" | "allowed" => {
		const decision = bashApprovalDecision(args);
		return typeof decision !== "string" && decision.critical === true ? "critical" : "allowed";
	};

	/** The call's own `env` is what the child gets, so it is what the guard must judge. */
	it("judges a variable supplied by the call's env argument, not the ambient one", () => {
		expect(verdict({ command: "rm -rf $LANG", env: { LANG: "/" } })).toBe("critical");
		expect(verdict({ command: "rm -rf $ANYTHING", env: { ANYTHING: "$HOME" } })).toBe("critical");
	});

	/** `VAR=/ rm -rf $VAR` binds the variable for the very command being judged. */
	it("applies an inline assignment, including behind env and sudo", () => {
		expect(verdict({ command: "PWD=/ rm -rf $PWD" })).toBe("critical");
		expect(verdict({ command: "env PWD=/ rm -rf $PWD" })).toBe("critical");
		expect(verdict({ command: "sudo FOO=/ rm -rf $FOO" })).toBe("critical");
	});

	/**
	 * A value that would word-split or glob is refused rather than pasted. The
	 * shell turns `rm -rf $V` with `V="/ /tmp/x"` into two arguments and
	 * `V="/*"` into every top-level entry; the guard models neither, so the only
	 * safe reading of such a value is no reading.
	 */
	it("refuses to substitute a value that would word-split or glob", () => {
		expect(verdict({ command: "rm -rf $V", env: { V: "/ /tmp/x" } })).toBe("critical");
		expect(verdict({ command: "rm -rf $V", env: { V: "/*" } })).toBe("critical");
		expect(verdict({ command: "rm -rf $V", env: { V: "$OTHER" } })).toBe("critical");
	});

	/** An operator form is unmodelled, and unmodelled must mean unknown. */
	it("treats a parameter expansion carrying an operator as unknown", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test, not a JS template.
		expect(verdict({ command: "rm -rf ${NOPE_UNSET:-/}" })).toBe("critical");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test, not a JS template.
		expect(verdict({ command: "rm -rf ${NOPE_UNSET-/}" })).toBe("critical");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test, not a JS template.
		expect(verdict({ command: "rm -rf ${HOME%%/*}" })).toBe("critical");
	});

	/**
	 * And the point of the whole exercise: a plainly-set variable naming an
	 * ordinary directory runs without a prompt. If this regresses, the guard is
	 * back to blocking `rm -rf $TMPDIR/scratch` and the complaint that started
	 * this is back with it.
	 */
	it("runs an ordinary delete through a set variable without asking", () => {
		expect(verdict({ command: "rm -rf $V/scratch", env: { V: "/tmp" } })).toBe("allowed");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test, not a JS template.
		expect(verdict({ command: "rm -rf ${V}/debug", env: { V: "/build/target" } })).toBe("allowed");
		expect(verdict({ command: "rm -rf node_modules" })).toBe("allowed");
	});

	/**
	 * An UNSET variable is still the fail-closed case the rule was written for,
	 * for every reading of it that is dangerous: the bare word is the root, a
	 * glob under it starts at the root, and a suffix naming a protected root is
	 * that root. An unset variable under an ordinary suffix is not on this list,
	 * and the suite next door is where that is stated.
	 */
	it("still refuses a variable nothing has set wherever a reading is dangerous", () => {
		expect(verdict({ command: "rm -rf $NOTHING_SETS_THIS" })).toBe("critical");
		expect(verdict({ command: "rm -rf $NOTHING_SETS_THIS/bin" })).toBe("critical");
		expect(verdict({ command: 'rm -rf "$dir"/*' })).toBe("critical");
	});
});

/**
 * Two holes found by testing the guard DIFFERENTIALLY against a real shell:
 * run the command with `rm` replaced by a printer, see what bash actually hands
 * it, and require the guard to have refused anything protected. Both were
 * fail-open and neither was reachable by reading the code.
 *
 *   cd / && rm -rf $PWD          bash deletes /, the guard read the old PWD
 *   rm -rf ../../../../../..     bash deletes /, the guard never judged it
 *
 * The first is a shell-MAINTAINED variable: its value at the moment the command
 * runs is not the one this process holds, and no read of the environment can be
 * right, so it is never substituted. The second is a relative path, which the
 * guard used to skip outright on the reasoning that refusing relative paths
 * would refuse ordinary work; resolving them against the working directory
 * keeps every ordinary relative delete and still catches the climb to the root.
 */
describe("paths the shell resolves differently from the process", () => {
	// A four-deep working directory, as a real project has, so `../..` lands
	// inside it and `../../../../../..` climbs past the root.
	const CWD = "/srv/work/proj/pkg";
	const decide = (command: string): "critical" | "allowed" => {
		const decision = bashApprovalDecision({ command }, [], CWD);
		return typeof decision !== "string" && decision.critical === true ? "critical" : "allowed";
	};

	/** `cd` rewrites PWD inside the very command being judged. */
	it("refuses a delete through a variable the shell maintains", () => {
		expect(decide("cd / && rm -rf $PWD")).toBe("critical");
		expect(decide("cd /; rm -rf $PWD")).toBe("critical");
		expect(decide("pushd / >/dev/null && rm -rf $PWD")).toBe("critical");
		// Even with no `cd` at all: the value can move before the delete runs, so
		// the guard does not pretend to know it.
		expect(decide("rm -rf $PWD")).toBe("critical");
	});

	/** A relative path that climbs out of the workspace is judged where it lands. */
	it("resolves a relative delete against the working directory and refuses an escape", () => {
		expect(decide("rm -rf ../../../../../..")).toBe("critical");
		expect(decide("rm -rf ../../../..")).toBe("critical");
	});

	/**
	 * And ordinary relative work is untouched, which is the half the original
	 * "relative is always fine" rule was protecting. A rule that refused these
	 * would be turned off within a day.
	 */
	it("still runs an ordinary relative delete without asking", () => {
		expect(decide("rm -rf node_modules")).toBe("allowed");
		expect(decide("rm -rf ./dist")).toBe("allowed");
		expect(decide("rm -rf ../build")).toBe("allowed");
		expect(decide("rm -rf ../sibling/dist")).toBe("allowed");
		expect(decide("rm -rf ../..")).toBe("allowed");
	});
});
