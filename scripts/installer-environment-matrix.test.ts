/**
 * A REAL install, once per environment veyyon claims to support.
 *
 * Every other installer suite here either greps install.sh for a string or calls
 * one helper in isolation. Neither notices when the pieces are individually right
 * and the whole install is wrong for an environment: a PATH line written to the rc
 * the user's shell does not read, completions written under `~/.local/share` while
 * `XDG_DATA_HOME` points elsewhere, a `$HOME` with a space in it losing half its
 * path. Those only show up when you run the installer end to end and then look at
 * the disposable HOME it produced.
 *
 * So this suite runs `sh scripts/install.sh --local` for real, once per case in
 * scripts/install-tests/environments.toml, inside a throwaway `$HOME`, and asserts
 * the same contract every time: exit 0, the binary in place byte-identically and
 * executable, the `vey` alias pointing at it, the PATH line in exactly the rc that
 * shell reads and in no other, every pre-existing byte of that rc still there, the
 * completion files at the paths the case's XDG variables imply, doctor's native
 * self-test passing, no staging file left behind, and a second run changing nothing
 * on disk. The environments themselves are Tier-B data: adding one is a TOML edit,
 * and nothing in this file names a shell or an XDG variable.
 *
 * The installed "binary" is a stand-in script, not the compiled veyyon. What is
 * under test here is install.sh's handling of the environment, and building a
 * 100 MB binary per case would make the matrix unrunnable. The stand-in is held to
 * the installer's actual probe contract by `the stand-in binary answers every probe
 * install.sh makes`, which reads the probes back out of install.sh, so a new probe
 * cannot be added without this suite failing rather than silently exercising a
 * shorter path than a real install.
 *
 * The disposable environment and the install itself live in
 * `scripts/install-tests/environment-matrix-harness.ts`, shared with the update
 * matrix so both suites assert against the same install.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	environmentCases as cases,
	cleanupEnvironmentMatrixTempRoots,
	type EnvironmentCase,
	type InstallRun,
	installSh,
	makeCheckout,
	PATH_MARKER,
	pathLineFor,
	rcTargetFor,
	runInstall,
	STAND_IN_BINARY,
} from "./install-tests/environment-matrix-harness";
import {
	halfWrittenTempsFor,
	OWNER_RECEIPT_SUFFIX,
	OWNER_RECEIPT_VERSION,
	ownerReceiptBodyFor,
	ownerReceiptFor,
	writeLegacyOwnerReceipt,
} from "./install-tests/installer-artifacts";

const installShSource = fs.readFileSync(installSh, "utf8");

/** Roots made by the kill cases below, which build their own environment. */
const tempRoots: string[] = [];

afterAll(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	cleanupEnvironmentMatrixTempRoots();
});

describe("the stand-in binary answers every probe install.sh makes", () => {
	/**
	 * The matrix is only as honest as its stand-in. If install.sh grows a fifth
	 * probe, every case here would take the "this build has no X yet" branch and
	 * the matrix would quietly stop covering the path a real install takes. So
	 * the probes are read back out of the installer and checked against the
	 * stand-in rather than trusted to stay in sync.
	 */
	it("covers the probes install.sh actually issues", () => {
		const probes = new Set<string>();
		for (const match of installShSource.matchAll(/"\$(?:bin|_dn_bin|local_bin)" ([a-z-]+)/g)) {
			probes.add(match[1] as string);
		}
		expect([...probes].sort()).toEqual(["--version", "completions", "grep"]);
		for (const probe of probes) expect(STAND_IN_BINARY).toContain(probe);
	});

	it("really searches for doctor's self-test instead of printing a canned match", () => {
		// doctor_natives writes `probe.txt` and requires the output to name it. A
		// stand-in that echoed "probe.txt" would pass even if the installer stopped
		// pointing it at a file, which is the failure doctor exists to catch.
		expect(STAND_IN_BINARY).toContain('exec grep -rl -- "$2" "$3"');
		expect(STAND_IN_BINARY).not.toContain("probe.txt");
	});
});

describe("the ownership receipt this suite recognizes", () => {
	/**
	 * The assertions below let one sidecar name survive in directories they
	 * otherwise require to hold no installer dot-file, so that name has to be the
	 * receipt install.sh really writes. The suffix and the body are read back out
	 * of the installer: rename either one and this fails here, naming the reason,
	 * instead of leaving the exemption pointed at a name nothing writes. Trusting
	 * a hand-copied name is how the assertions below went stale in the first place.
	 */
	it("matches the sidecar install.sh writes and uninstall reads", () => {
		expect(installShSource).toContain(`printf '%s/.%s${OWNER_RECEIPT_SUFFIX}'`);
		expect(installShSource).toContain(`printf '%s\\n%s\\n' '${OWNER_RECEIPT_VERSION}' "$_owner_identity"`);
		expect(installShSource).toContain(`NR == 1 && $0 != "${OWNER_RECEIPT_VERSION}" { exit 1 }`);
	});

	it("accepts the receipt only while the file it describes is still there", () => {
		/**
		 * CONTRACT: the receipt vouches for a FILE, not for a path, and the three
		 * lines below are the whole of that guarantee in install.sh.
		 *
		 * The v1 receipt was the bare constant `veyyon-installer-v1`, so an
		 * installed binary deleted by hand left a sidecar that handed ownership to
		 * whatever took the name next: the installer would overwrite, and uninstall
		 * would delete, a file it never wrote. Pinning the shape here rather than
		 * only exercising it end to end means the recompute cannot be dropped back
		 * to a constant comparison without a named failure, which is exactly how the
		 * v1 form survived review.
		 */
		// The recorded identity is compared against one computed NOW, from the file.
		expect(installShSource).toContain('_receipt_actual=$(artifact_identity "$1")');
		expect(installShSource).toContain('[ "$_receipt_recorded" = "$_receipt_actual" ]');
		// A receipt that does not match settles the question: the structural
		// fallbacks below it must not hand ownership back.
		expect(installShSource).toContain('owner_receipt_identity "$_binary_path" >/dev/null 2>&1 && return 1');
		// And an identity that cannot be computed refuses to become a receipt,
		// rather than writing one that vouches for nothing.
		expect(installShSource).toContain('_owner_identity=$(artifact_identity "$1") || return 1');
	});
});

describe.each(cases.map(c => [c.name, c] as const))("install into %s", (_name, testCase) => {
	const first = runInstall(testCase);
	const binary = path.join(first.installDir, "veyyon");
	const alias = path.join(first.installDir, "vey");

	it("exits 0", () => {
		expect(first.output).not.toContain("error:");
		expect(first.exitCode).toBe(0);
	});

	it("installs the binary byte-identically and executable", () => {
		// A truncated copy or a file left non-executable is an install that
		// reports success and then cannot run.
		expect(fs.readFileSync(binary, "utf8")).toBe(STAND_IN_BINARY);
		expect(fs.statSync(binary).mode & 0o111).toBe(0o111);
	});

	if (testCase.alias_is_foreign) {
		it("leaves a `vey` the user already owns exactly as it was", () => {
			// `ln -sf` unlinks whatever is at the path first, which is how a user's
			// own script in the install directory was destroyed with no warning and
			// no way to get it back. Their file, byte for byte, and still not a
			// symlink of ours.
			expect(fs.lstatSync(alias).isSymbolicLink()).toBe(false);
			const seeded = testCase.pre_files?.[`${testCase.install_dir}/vey`];
			expect(seeded).toBeDefined();
			expect(fs.readFileSync(alias, "utf8")).toBe(seeded as string);
		});

		it("stops binding that name in our own completion scripts", () => {
			// The decisive half. Declining to write the alias FILE is not enough:
			// every generated script normally completes both names, so ours would
			// hand our subcommands to their tool.
			const bash = path.join(first.home, ".local/share/bash-completion/completions/veyyon");
			expect(fs.readFileSync(bash, "utf8")).not.toMatch(/^complete -F _veyyon veyyon vey\b/m);
			expect(fs.readFileSync(bash, "utf8")).toContain("complete -F _veyyon veyyon");
		});
	} else {
		it("links `vey` at the installed binary", () => {
			// The documented command is `vey`; an alias pointing anywhere else (or at
			// a path that does not resolve) means the documented command is broken.
			expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(alias)).toBe(fs.realpathSync(binary));
		});
	}

	it("passes doctor's native self-test on the installed binary", () => {
		// The install is not finished when the file lands; doctor is what proves
		// the thing that landed runs and can search.
		expect(first.output).toContain("veyyon runs — veyyon/9.9.9");
		expect(first.output).toContain("native addon loads (installed)");
	});

	/**
	 * Each staging file is a full copy of the binary. One left behind after a
	 * clean install means the cleanup contract is broken.
	 *
	 * This used to assert that nothing in the install dir starts with `.veyyon.`,
	 * which held while staging was the only dot-file the installer could write
	 * there. It is wrong now: `mark_artifact_owned` writes a durable
	 * `.veyyon.veyyon-owner` receipt beside the binary, and `--uninstall` refuses
	 * to remove a binary that has no receipt, so the old form demanded the
	 * installer drop the one file that makes uninstall work.
	 *
	 * Pinning the whole listing is stronger than exempting the receipt by name. It
	 * still fails on a leaked staging file (`.veyyon.local.<pid>`) or a leaked
	 * receipt temp (`.veyyon.veyyon-owner.<pid>`), it fails on anything else the
	 * installer starts leaving in a directory the user owns, and it now also fails
	 * when the receipt is MISSING, which the old form could not tell apart from a
	 * clean install.
	 */
	it("leaves no staging file behind in the install dir", () => {
		const receipt = ownerReceiptFor(binary);
		expect(fs.readdirSync(first.installDir).sort()).toEqual([path.basename(receipt), "vey", "veyyon"]);
		// Well-formed, not merely present, and describing THIS binary: a receipt
		// carrying any other file's identity is one uninstall will refuse to act on.
		expect(fs.readFileSync(receipt, "utf8")).toBe(ownerReceiptBodyFor(binary));
	});

	if (testCase.expect_rc) {
		const rcRel = testCase.expect_rc;
		it(`writes the PATH line to ${rcRel} and nowhere else`, () => {
			const rc = path.join(first.home, rcRel);
			const content = fs.readFileSync(rc, "utf8");
			const line = pathLineFor(rcRel, first.installDir);
			expect(content.split("\n").filter(l => l === line)).toEqual([line]);
			expect(content).toContain(PATH_MARKER);
			// Every other rc this installer could have chosen must be untouched:
			// a line in the wrong file is a PATH the user's shell never gets.
			for (const other of [".bashrc", ".bash_profile", ".profile", ".zshrc", ".config/fish/config.fish"]) {
				if (other === rcRel) continue;
				const otherPath = path.join(first.home, other);
				if (!fs.existsSync(otherPath)) continue;
				expect(fs.readFileSync(otherPath, "utf8"), `${other} must not carry the PATH line`).not.toContain(
					PATH_MARKER,
				);
			}
		});

		it(`preserves every pre-existing byte of ${rcRel}`, () => {
			// Appending is the only sanctioned edit. A rewrite that reorders or
			// drops a line the user wrote is unrecoverable data loss in a file
			// they did not ask this installer to manage.
			// The rc's own seed, by its own key — not "whatever the first pre_file
			// was". A case that seeds something else entirely (a `vey` in the
			// install directory) would otherwise be told its rc started life as a
			// shell script. A symlinked rc is seeded at the link's target, so that
			// is where the key comes from.
			const linked = testCase.pre_symlinks?.[rcRel];
			const seedKey = linked === undefined ? rcRel : linked.replace("$HOME/", "");
			const before = testCase.pre_files?.[seedKey] ?? "";
			const after = fs.readFileSync(rcTargetFor(testCase, rcRel, first.home), "utf8");
			if (before) expect(after.startsWith(before)).toBe(true);
			expect(after).toBe(`${before}\n${PATH_MARKER}\n${pathLineFor(rcRel, first.installDir)}\n`);
		});

		it(`writes a ${rcRel} that a shell can source without corrupting the path`, () => {
			// The assertion above pins the BYTES; this one pins what those bytes
			// DO, which is the thing that actually broke: a directory written
			// into a double-quoted string expanded when the profile was sourced,
			// so the entry that landed on PATH was not the directory the line
			// named. Reading the file back and asserting a string cannot see
			// that. Running it can, so this sources the real rc in a real shell
			// and asks where the first PATH entry points.
			//
			// fish is not POSIX and is not necessarily installed, so its line is
			// checked as an argument list instead: `fish_add_path <dir>` splits
			// and globs an unquoted argument exactly the way `sh` does.
			const line = pathLineFor(rcRel, first.installDir);
			const script = rcRel.endsWith("config.fish")
				? `set -- ${line.replace(/^fish_add_path /, "")}\nprintf '%s\\n' "$#" "$1"\n`
				: `PATH=/usr/bin\n${line}\nprintf '%s\\n' "\${PATH%%:*}"\n`;
			const run = Bun.spawnSync(["sh", "-c", script.replaceAll("\\n", "\n")], {
				env: { ...process.env, HOME: first.home },
			});
			expect(run.exitCode).toBe(0);
			const out = new TextDecoder().decode(run.stdout).trimEnd().split("\n");
			if (rcRel.endsWith("config.fish")) {
				// Exactly one argument, and it is the directory unchanged: a
				// space would make two, a glob could make none or many.
				expect(out).toEqual(["1", first.installDir]);
			} else {
				expect(out).toEqual([first.installDir]);
			}
		});

		it("adds nothing on a second install and says the PATH is already configured", () => {
			// A reinstall used to append a duplicate line and tell the user to add
			// the directory themselves. Both are wrong: the rc must be byte-identical.
			const rcTarget = rcTargetFor(testCase, rcRel, first.home);
			const before = fs.readFileSync(rcTarget, "utf8");
			const second = runInstall(testCase, first);
			expect(second.exitCode).toBe(0);
			expect(fs.readFileSync(rcTarget, "utf8")).toBe(before);
			expect(second.output).toContain("is already on PATH in");
		});
	}

	const symlinkedRc = testCase.expect_rc_stays_symlink ? testCase.expect_rc : undefined;
	if (symlinkedRc !== undefined) {
		it("appends through the symlink instead of replacing it with a regular file", () => {
			// A dotfiles-managed rc is a link into a repo. Replacing it detaches
			// the user's dotfiles from their repo with nothing on screen to say so.
			expect(fs.lstatSync(path.join(first.home, symlinkedRc)).isSymbolicLink()).toBe(true);
			const target = rcTargetFor(testCase, symlinkedRc, first.home);
			expect(target).not.toBe(path.join(first.home, symlinkedRc));
			expect(fs.readFileSync(target, "utf8")).toContain(PATH_MARKER);
		});
	}

	for (const rel of testCase.expect_completions ?? []) {
		/**
		 * A completion file at the wrong path is not a completion: the shell
		 * autoloads by exact directory and name.
		 *
		 * The temp check here used to filter every sibling starting with
		 * `.<name>.`, so it also caught `.<name>.veyyon-owner`, the ownership
		 * receipt `mark_artifact_owned` writes AFTER the move. That receipt is what
		 * `completion_artifact_is_ours` reads, so requiring its absence required an
		 * uninstall that leaves the file behind as somebody else's. It is now
		 * excluded from the temp sweep by its exact name and asserted to exist with
		 * the body uninstall greps for, so the half-written contract still holds and
		 * the ownership contract is pinned instead of ignored.
		 */
		it(`writes the completion file at ${rel}`, () => {
			const file = path.join(first.home, rel);
			expect(fs.existsSync(file), `${file} must exist`).toBe(true);
			expect(fs.readFileSync(file, "utf8").length).toBeGreaterThan(0);
			const receipt = ownerReceiptFor(file);
			expect(fs.existsSync(receipt), `${receipt} must record our ownership`).toBe(true);
			expect(fs.readFileSync(receipt, "utf8")).toBe(ownerReceiptBodyFor(file));
			// Nothing half-written: the generator writes `.<name>.<pid>` and moves it.
			expect(halfWrittenTempsFor(file)).toEqual([]);
		});
	}

	for (const rel of testCase.expect_absent ?? []) {
		it(`writes nothing at ${rel}`, () => {
			expect(fs.existsSync(path.join(first.home, rel)), `${rel} must not be created`).toBe(false);
		});
	}

	if (testCase.install_dir_on_path) {
		it("says the directory is already on PATH rather than editing a shell rc", () => {
			// Nothing to do is not the same as failing to do it: appending a line
			// no shell needs edits a file the user owns for no reason.
			expect(first.output).not.toContain(PATH_MARKER);
			expect(first.output).not.toContain("add ");
		});
	}
});

describe("an install killed mid-copy", () => {
	/**
	 * The staging file is a full copy of the binary (~100 MB for the real one).
	 * The EXIT/INT/TERM trap covers Ctrl-C and a failed copy, but nothing survives
	 * SIGKILL, and until `sweep_stale_staging` existed only `--uninstall` ever
	 * reclaimed those files: a user whose install kept getting killed accumulated
	 * hundreds of megabytes of hidden files in their install directory, with
	 * nothing on screen naming them.
	 *
	 * The kill window is made deterministic by putting a `cp` that sleeps first on
	 * PATH, so the signal always lands while the copy is in flight and the trap is
	 * armed — not by racing a real copy and hoping.
	 */
	const matrixCase: EnvironmentCase = {
		name: "kill",
		shell: "/bin/zsh",
		home_dir: "killed-install",
		install_dir: ".local/bin",
	};

	function stageKillableInstall(): {
		root: string;
		home: string;
		installDir: string;
		checkout: string;
		env: Record<string, string>;
	} {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-kill-"));
		tempRoots.push(root);
		const home = path.join(root, matrixCase.home_dir);
		const installDir = path.join(home, matrixCase.install_dir);
		fs.mkdirSync(installDir, { recursive: true });
		const checkout = makeCheckout(root);
		const shims = path.join(root, "shims");
		fs.mkdirSync(shims, { recursive: true });
		fs.writeFileSync(
			path.join(shims, "cp"),
			'#!/bin/sh\n# Slow `cp` shim: widens the staging window so a signal lands inside it.\nsleep 2\nexec /bin/cp "$@"\n',
			{ mode: 0o755 },
		);
		const tmp = path.join(root, "tmp");
		fs.mkdirSync(tmp, { recursive: true });
		return {
			root,
			home,
			installDir,
			checkout,
			env: {
				HOME: home,
				SHELL: matrixCase.shell,
				VEYYON_INSTALL_DIR: installDir,
				PATH: `${shims}:/usr/local/bin:/usr/bin:/bin`,
				TMPDIR: tmp,
			},
		};
	}

	it("removes its own staging file when it is asked to stop (SIGTERM)", async () => {
		const staged = stageKillableInstall();
		const child = Bun.spawn(["sh", installSh, "--local"], {
			cwd: staged.checkout,
			env: staged.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		await Bun.sleep(400);
		child.kill("SIGTERM");
		await child.exited;
		// The trap runs once the copy it interrupted returns.
		await Bun.sleep(2500);
		expect(fs.readdirSync(staged.installDir).filter(n => n.startsWith(".veyyon."))).toEqual([]);
		expect(fs.existsSync(path.join(staged.installDir, "veyyon"))).toBe(false);
	}, 20_000);

	it("leaves the staging file behind on SIGKILL, and the next install reclaims it by name", async () => {
		const staged = stageKillableInstall();
		const child = Bun.spawn(["sh", installSh, "--local"], {
			cwd: staged.checkout,
			env: staged.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const killedPid = child.pid;
		await Bun.sleep(400);
		child.kill("SIGKILL");
		await child.exited;
		// The orphaned copy finishes writing the staging file the shell can no
		// longer clean up: this is the litter the sweep exists for.
		await Bun.sleep(2500);
		const leftover = `.veyyon.local.${killedPid}`;
		expect(fs.readdirSync(staged.installDir)).toContain(leftover);

		// Now a normal install, with the real `cp` back on PATH.
		const rerun = Bun.spawnSync(["sh", installSh, "--local"], {
			cwd: staged.checkout,
			env: { ...staged.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${rerun.stdout.toString()}${rerun.stderr.toString()}`;
		expect(rerun.exitCode).toBe(0);
		expect(output).toContain(`removed ${path.join(staged.installDir, leftover)} left by an interrupted install`);
		// The sweep reclaimed the leftover and the finished install left exactly its
		// own artifacts. `.veyyon.veyyon-owner` is one of them: the receipt
		// `--uninstall` requires, not litter, which is why this no longer demands
		// that nothing here starts with `.veyyon.`.
		const receipt = ownerReceiptFor(path.join(staged.installDir, "veyyon"));
		expect(fs.readdirSync(staged.installDir).sort()).toEqual([path.basename(receipt), "vey", "veyyon"]);
		expect(fs.readFileSync(receipt, "utf8")).toBe(ownerReceiptBodyFor(path.join(staged.installDir, "veyyon")));
		expect(fs.readFileSync(path.join(staged.installDir, "veyyon"), "utf8")).toBe(STAND_IN_BINARY);
	}, 30_000);

	it("keeps a staging file whose installer is still running", () => {
		// The pid is in the staging path so two installers cannot share one.
		// Sweeping a live pid's file would delete that process's partial copy out
		// from under it, which is worse than the disk it holds.
		const staged = stageKillableInstall();
		const live = path.join(staged.installDir, `.veyyon.local.${process.pid}`);
		fs.writeFileSync(live, "another installer's partial copy");
		const rerun = Bun.spawnSync(["sh", installSh, "--local"], {
			cwd: staged.checkout,
			env: { ...staged.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${rerun.stdout.toString()}${rerun.stderr.toString()}`;
		expect(rerun.exitCode).toBe(0);
		expect(fs.readFileSync(live, "utf8")).toBe("another installer's partial copy");
		expect(output).toContain(`leaving ${live} alone`);
	}, 20_000);
});

describe("the ownership receipt vouches for the file, not for the path", () => {
	/**
	 * WHY THIS EXISTS. The receipt used to hold one constant line, so it said
	 * "this installer owns whatever is at this path". Delete an installed binary
	 * by hand and the sidecar stayed; put your own `veyyon` at that name and it
	 * inherited the ownership. The installer would then overwrite a file it never
	 * wrote, and `--uninstall` would delete it, on a path the user had already
	 * taken back.
	 *
	 * Every case below runs the real installer end to end, because the gate is
	 * only worth anything where it is actually consulted: `finalize_binary` before
	 * a replacement and `do_uninstall` before a removal. The matrix above proves
	 * an install is well formed; this proves who it will and will not touch.
	 */
	const ownershipCase: EnvironmentCase = {
		name: "ownership",
		shell: "/bin/bash",
		home_dir: "ownership",
		install_dir: ".local/bin",
	};

	/** A finished install, plus the paths every case below reaches for. */
	function freshInstall(): { run: InstallRun; binary: string; alias: string; receipt: string } {
		const run = runInstall(ownershipCase);
		expect(run.exitCode).toBe(0);
		const binary = path.join(run.installDir, "veyyon");
		return { run, binary, alias: path.join(run.installDir, "vey"), receipt: ownerReceiptFor(binary) };
	}

	function uninstall(run: InstallRun): string {
		const done = Bun.spawnSync(["sh", installSh, "--uninstall"], {
			cwd: run.checkout,
			env: run.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return `${done.stdout.toString()}${done.stderr.toString()}`;
	}

	/** What the user did: took the path back, keeping whatever the installer left. */
	const FOREIGN = "#!/bin/sh\necho USER OWN SCRIPT\n";
	function replaceBinaryByHand(binary: string): void {
		fs.rmSync(binary);
		fs.writeFileSync(binary, FOREIGN, { mode: 0o751 });
	}

	it("refuses to replace a file that inherited an orphaned receipt", () => {
		// The reported defect, end to end. The receipt is downgraded to the v1 body
		// a released installer really wrote, and the alias is removed, so what is
		// left on disk is exactly what a user who deleted the binary by hand has:
		// a sidecar with no file to describe.
		const { run, binary, alias, receipt } = freshInstall();
		fs.rmSync(alias);
		writeLegacyOwnerReceipt(binary);
		replaceBinaryByHand(binary);

		const rerun = runInstall(ownershipCase, run);
		expect(rerun.exitCode).not.toBe(0);
		expect(rerun.output).toContain(`refusing to replace ${binary}`);
		expect(rerun.output).toContain("cannot be confirmed against the file that is there now");
		// The user's file is the whole point: byte-identical, mode intact.
		expect(fs.readFileSync(binary, "utf8")).toBe(FOREIGN);
		expect(fs.statSync(binary).mode & 0o777).toBe(0o751);
		expect(fs.existsSync(receipt)).toBe(true);
	});

	it("refuses even while its own alias still points at the path", () => {
		// The realistic shape of the same accident: `rm ~/.local/bin/veyyon` leaves
		// our `vey` symlink behind, and `vey` is installer-specific evidence that
		// survives any replacement of the file beside it. A receipt this installer
		// wrote and cannot match now settles the question BEFORE that evidence is
		// consulted, or the alias would hand a stranger's file straight back.
		const { run, binary, alias } = freshInstall();
		replaceBinaryByHand(binary);
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);

		const rerun = runInstall(ownershipCase, run);
		expect(rerun.exitCode).not.toBe(0);
		expect(rerun.output).toContain("it has changed since this installer wrote it");
		expect(fs.readFileSync(binary, "utf8")).toBe(FOREIGN);
	});

	it("reinstalls over its own install and re-stamps the receipt", () => {
		// The other half of the same rule: a gate that refuses an install over its
		// own work is worse than the hole it closes, so the ordinary path has to
		// stay ordinary. The receipt is compared against the binary on disk, so a
		// reinstall that replaced the bytes without rewriting the sidecar fails
		// here rather than at the user's next uninstall.
		const { run, binary, receipt } = freshInstall();
		expect(fs.readFileSync(receipt, "utf8")).toBe(ownerReceiptBodyFor(binary));

		const rerun = runInstall(ownershipCase, run);
		expect(rerun.exitCode).toBe(0);
		expect(rerun.output).not.toContain("refusing to replace");
		expect(fs.readFileSync(binary, "utf8")).toBe(STAND_IN_BINARY);
		expect(fs.readFileSync(receipt, "utf8")).toBe(ownerReceiptBodyFor(binary));
	});

	it("adopts a pre-identity receipt on the next install and upgrades it", () => {
		// The compatibility window, asserted rather than assumed. Installs up to
		// v1.0.46 wrote a receipt with no identity in it, and refusing all of them
		// would strand every existing user on an installer that will not replace
		// its own binary. Such an install is adopted through the same
		// installer-specific evidence that adopts a pre-receipt install, and the
		// contact rewrites the sidecar to v2 — which is what closes the window
		// above for that machine, permanently.
		const { run, binary, receipt } = freshInstall();
		writeLegacyOwnerReceipt(binary);

		const rerun = runInstall(ownershipCase, run);
		expect(rerun.exitCode).toBe(0);
		expect(fs.readFileSync(receipt, "utf8")).toBe(ownerReceiptBodyFor(binary));
		expect(fs.readFileSync(receipt, "utf8")).toContain(OWNER_RECEIPT_VERSION);
	});

	it("uninstall still removes the binary and receipt it owns", () => {
		// An identity check that made uninstall stop reclaiming its own artifacts
		// would trade one silent mess for another, so the removal path is asserted
		// against the same install, not only the replacement path.
		const { run, binary, alias, receipt } = freshInstall();
		const output = uninstall(run);
		expect(output).toContain(`removed ${binary}`);
		expect(fs.existsSync(binary)).toBe(false);
		expect(fs.existsSync(alias)).toBe(false);
		// The sidecar goes with the file. An orphan left here is the defect above,
		// pre-armed for whatever takes the name next.
		expect(fs.existsSync(receipt)).toBe(false);
	});

	it("uninstall leaves a foreign file with no receipt alone", () => {
		// Unchanged behaviour, asserted beside the new rule so a future tightening
		// of the receipt cannot quietly turn "left alone" into "removed".
		const { run, binary, alias, receipt } = freshInstall();
		fs.rmSync(alias);
		fs.rmSync(receipt);
		replaceBinaryByHand(binary);

		const output = uninstall(run);
		expect(output).toContain(`left ${binary} alone (not created by this installer)`);
		expect(fs.readFileSync(binary, "utf8")).toBe(FOREIGN);
	});

	it("uninstall leaves a binary that changed since the receipt, and says why", () => {
		// The same refusal on the removal side, with the reason the summary line
		// cannot carry: "not created by this installer" is true but would send a
		// user hunting for a second veyyon that does not exist.
		const { run, binary } = freshInstall();
		replaceBinaryByHand(binary);

		const output = uninstall(run);
		expect(output).toContain(`left ${binary} alone (not created by this installer)`);
		expect(output).toContain("has changed since, so the file there now is not the one that was installed");
		expect(fs.readFileSync(binary, "utf8")).toBe(FOREIGN);
	});
});
