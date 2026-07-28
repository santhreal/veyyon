/**
 * The disposable environment a matrix case runs in, and the real install into it.
 *
 * Two suites need exactly this: `scripts/installer-environment-matrix.test.ts`
 * asserts what the installer did to the environment, and
 * `scripts/update-environment-matrix.test.ts` then updates that same install and
 * asserts what the updater did to it. They share one harness rather than two
 * copies of the `$HOME` construction, because the moment the copies differ the
 * update suite is testing an environment the installer suite never produced, and
 * neither failure would name the divergence.
 *
 * Nothing here names a shell or an XDG variable. The environments are Tier-B
 * data in `environments.toml`, so covering a new one is a TOML edit and it covers
 * both halves of the product at once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import environments from "./environments.toml";

/** The repository root, from this file's location. */
export const repoRoot = path.resolve(import.meta.dir, "../..");
export const installSh = path.join(repoRoot, "scripts", "install.sh");

/** The comment install.sh writes above the PATH line it owns. */
export const PATH_MARKER = "# added by the veyyon installer";

/** One environment from the Tier-B matrix. */
export interface EnvironmentCase {
	name: string;
	shell: string;
	home_dir: string;
	install_dir: string;
	env?: Record<string, string>;
	pre_files?: Record<string, string>;
	pre_symlinks?: Record<string, string>;
	expect_rc?: string;
	expect_completions?: string[];
	expect_absent?: string[];
	expect_rc_stays_symlink?: boolean;
	install_dir_on_path?: boolean;
}

/** Every environment the matrix covers, in the order the TOML lists them. */
export const environmentCases = (environments as { case: EnvironmentCase[] }).case;

/**
 * What the installer runs the binary for, and what it expects back.
 *
 * install.sh probes the binary during a `--local` install. The stand-in answers
 * exactly those probes and nothing else, and `grep` really searches so doctor's
 * native self-test is answered with a real match rather than a canned line that
 * would pass even if the installer stopped pointing it at a file.
 *
 * `version` is a parameter so the update suite can build a SECOND stand-in that
 * is byte-different from the installed one. Every assertion about an update
 * distinguishing the new binary from the old one rests on that difference.
 *
 * `--version` answers `veyyon/X.Y.Z`, which is the shipped binary's format and
 * not a convenience. install.sh's parser takes any `x.y.z` token on the line, so
 * a looser spelling passed the install matrix, but `verifyBinaryVersion` in the
 * updater matches on the slash and would have refused every swap the update
 * matrix makes. A stand-in that answers a format the product does not produce
 * tests a contract nobody ships.
 */
export function standInBinary(version: string): string {
	return `#!/bin/sh
# Stand-in for the compiled veyyon, used by the environment matrices.
set -u
case "\${1:-}" in
	--version) echo "veyyon/${version}"; exit 0 ;;
	completions)
		case "\${2:-}" in
			--help) echo "usage: veyyon completions <bash|zsh|fish>"; exit 0 ;;
			bash) echo "complete -F _veyyon veyyon vey # ${version}"; exit 0 ;;
			zsh) echo "#compdef veyyon vey # ${version}"; exit 0 ;;
			fish) echo "complete -c veyyon # ${version}"; exit 0 ;;
			*) echo "unknown shell" >&2; exit 2 ;;
		esac ;;
	grep)
		[ "\${2:-}" = "--help" ] && { echo "usage: veyyon grep <pattern> <path>"; exit 0; }
		exec grep -rl -- "$2" "$3" ;;
	*) echo "unknown command: \${1:-}" >&2; exit 2 ;;
esac
`;
}

/** The version the installed stand-in reports. */
export const INSTALLED_VERSION = "9.9.9";
/** The version an update installs over it, chosen to differ in every digit that matters. */
export const UPDATED_VERSION = "9.9.10";

export const STAND_IN_BINARY = standInBinary(INSTALLED_VERSION);
export const UPDATED_STAND_IN_BINARY = standInBinary(UPDATED_VERSION);

const tempRoots: string[] = [];

/**
 * Remove every disposable root this harness made.
 *
 * Call it from an `afterAll`. The temp-dir janitor would also reach these, since
 * they are `mkdtemp` results under `os.tmpdir()`, but an install matrix leaves
 * hundreds of megabytes per run and waiting for the janitor's file-scoped hook
 * means holding all of it at once.
 */
export function cleanupEnvironmentMatrixTempRoots(): void {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** A disposable checkout whose `dist/vey` is the stand-in binary. */
export function makeCheckout(root: string): string {
	const checkout = path.join(root, "checkout");
	fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
	const binary = path.join(checkout, "dist", "vey");
	fs.writeFileSync(binary, STAND_IN_BINARY, { mode: 0o755 });
	return checkout;
}

export interface InstallRun {
	exitCode: number;
	output: string;
	home: string;
	installDir: string;
	checkout: string;
	env: Record<string, string>;
}

/**
 * The directory `install_dir()` resolves a request to: trailing slashes stripped,
 * with `/` left alone because there the slash IS the directory. Kept in step with
 * install.sh by `functions.test.sh`, which asserts the same cases against the
 * shell function itself.
 */
export function normalizeInstallDir(dir: string): string {
	let value = dir;
	while (value.endsWith("/") && value !== "/") value = value.slice(0, -1);
	return value;
}

/**
 * Run the real installer for one case, in a $HOME that exists only for it.
 *
 * A reinstall passes the first run back in: re-staging the case's `pre_files`
 * would rewrite the rc the first install just appended to, so the second run
 * would be starting from a clean rc and "adds nothing on a second install" would
 * pass no matter what the installer did.
 */
export function runInstall(testCase: EnvironmentCase, previous?: InstallRun): InstallRun {
	if (previous) {
		const rerun = Bun.spawnSync(["sh", installSh, "--local"], {
			cwd: previous.checkout,
			env: previous.env,
			stderr: "pipe",
			stdout: "pipe",
		});
		return { ...previous, exitCode: rerun.exitCode, output: `${rerun.stdout.toString()}${rerun.stderr.toString()}` };
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-env-matrix-"));
	tempRoots.push(root);
	const home = path.join(root, testCase.home_dir);
	fs.mkdirSync(home, { recursive: true });
	// What the case ASKS for, which is what the installer is handed, and what the
	// installer RESOLVES it to, which is what every assertion compares against.
	// They differ when a case spells the directory with a trailing slash:
	// `install_dir()` strips it, because the PATH membership test and the rc line
	// are string comparisons and `.local/bin/` would not match the entry the
	// installer itself wrote. Mirroring that here rather than normalizing the
	// input keeps the trailing-slash spelling actually under test.
	const requestedInstallDir = testCase.install_dir.startsWith("/")
		? testCase.install_dir
		: path.join(home, testCase.install_dir);
	const installDir = normalizeInstallDir(requestedInstallDir);
	const checkout = makeCheckout(root);

	for (const [rel, content] of Object.entries(testCase.pre_files ?? {})) {
		const target = path.join(home, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	for (const [rel, target] of Object.entries(testCase.pre_symlinks ?? {})) {
		const link = path.join(home, rel);
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(target.replace("$HOME", home), link);
	}

	// A PATH holding the system tools the installer needs, and deliberately NOT
	// the install dir unless the case asks for it: that is the difference between
	// "write the rc line" and "there is nothing to do".
	const basePath = "/usr/local/bin:/usr/bin:/bin";
	const env: Record<string, string> = {
		HOME: home,
		SHELL: testCase.shell,
		VEYYON_INSTALL_DIR: requestedInstallDir,
		PATH: testCase.install_dir_on_path ? `${installDir}:${basePath}` : basePath,
		TMPDIR: path.join(root, "tmp"),
	};
	fs.mkdirSync(env.TMPDIR, { recursive: true });
	for (const [key, value] of Object.entries(testCase.env ?? {})) {
		env[key] = value.replaceAll("$HOME", home);
	}
	if (testCase.install_dir_on_path) fs.mkdirSync(installDir, { recursive: true });

	const run = Bun.spawnSync(["sh", installSh, "--local"], { cwd: checkout, env, stderr: "pipe", stdout: "pipe" });
	return {
		exitCode: run.exitCode,
		output: `${run.stdout.toString()}${run.stderr.toString()}`,
		home,
		installDir,
		checkout,
		env,
	};
}

/**
 * Where an rc's bytes actually live: through the case's symlink when it has one.
 *
 * One owner for this, because a dotfiles case has to be read at the link's target
 * and every rc assertion needs the same answer.
 */
export function rcTargetFor(testCase: EnvironmentCase, rcRel: string, home: string): string {
	const linked = testCase.pre_symlinks?.[rcRel];
	return linked === undefined ? path.join(home, rcRel) : linked.replaceAll("$HOME", home);
}

/**
 * The directory as install.sh's `shell_single_quote` writes it.
 *
 * Single quotes, with a literal quote closed, escaped and reopened, which is the
 * only way to put one inside single quotes in POSIX sh.
 */
export function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The PATH line install.sh writes for this rc, per its `path_line_for`.
 *
 * The directory is quoted, and that is the point of the spelling rather than a
 * detail of it: written into a double-quoted string, a home directory containing
 * `$` expanded when the profile was sourced and put a nonsense entry on PATH, so
 * `veyyon` was not found in a shell whose profile plainly named the right
 * directory. A backtick or a backslash is the same bug.
 */
export function pathLineFor(rc: string, installDir: string): string {
	const quoted = shellSingleQuote(installDir);
	return rc.endsWith("config.fish") ? `fish_add_path ${quoted}` : `export PATH=${quoted}:"$PATH"`;
}
