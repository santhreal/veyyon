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
	type EnvironmentCase,
	cleanupEnvironmentMatrixTempRoots,
	environmentCases as cases,
	installSh,
	makeCheckout,
	PATH_MARKER,
	pathLineFor,
	rcTargetFor,
	repoRoot,
	runInstall,
	STAND_IN_BINARY,
} from "./install-tests/environment-matrix-harness";

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

	it("links `vey` at the installed binary", () => {
		// The documented command is `vey`; an alias pointing anywhere else (or at
		// a path that does not resolve) means the documented command is broken.
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(alias)).toBe(fs.realpathSync(binary));
	});

	it("passes doctor's native self-test on the installed binary", () => {
		// The install is not finished when the file lands; doctor is what proves
		// the thing that landed runs and can search.
		expect(first.output).toContain("veyyon runs — veyyon/9.9.9");
		expect(first.output).toContain("native addon loads (installed)");
	});

	it("leaves no staging file behind in the install dir", () => {
		// Each staging file is a full copy of the binary. One left behind after a
		// clean install means the cleanup contract is broken.
		const leftovers = fs.readdirSync(first.installDir).filter(name => name.startsWith(".veyyon."));
		expect(leftovers).toEqual([]);
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
			const before = testCase.pre_files?.[rcRel] ?? Object.values(testCase.pre_files ?? {})[0] ?? "";
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
		it(`writes the completion file at ${rel}`, () => {
			// A completion file at the wrong path is not a completion: the shell
			// autoloads by exact directory and name.
			const file = path.join(first.home, rel);
			expect(fs.existsSync(file), `${file} must exist`).toBe(true);
			expect(fs.readFileSync(file, "utf8").length).toBeGreaterThan(0);
			// Nothing half-written: the generator writes to a temp and moves it.
			const dir = fs.readdirSync(path.dirname(file));
			expect(dir.filter(name => name.startsWith(`.${path.basename(file)}.`))).toEqual([]);
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
		expect(fs.readdirSync(staged.installDir).filter(n => n.startsWith(".veyyon."))).toEqual([]);
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
