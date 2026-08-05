/**
 * The launcher a source install puts on PATH.
 *
 * `install.sh --source` symlinks `~/.local/bin/veyyon` at
 * `<checkout>/packages/coding-agent/scripts/veyyon`, so this shell script IS
 * the command for every source user. It runs before any TypeScript does, which
 * means every failure here is a raw shell or bun error with no veyyon voice
 * behind it, on a command the user installed successfully minutes earlier.
 *
 * The two preconditions it cannot assume: bun is still on PATH (it drops off
 * routinely, in a non-login shell that never sources the rc holding
 * `~/.bun/bin`, or after a PATH edit or a bun uninstall), and the checkout it
 * points into still exists (the PATH symlink survives the tree being moved or
 * half-deleted, and then hands bun a path to nothing).
 *
 * These run the real script with a controlled PATH, so they assert what a user
 * sees rather than what the source says.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const launcher = path.resolve(import.meta.dir, "..", "scripts", "veyyon");

/** Run the launcher with a PATH holding only `dirs`, and capture its output. */
function runLauncher(script: string, dirs: string[]): { exitCode: number; stderr: string } {
	const proc = Bun.spawnSync(["/bin/sh", script, "--version"], {
		env: { PATH: dirs.join(path.delimiter), HOME: process.env.HOME ?? "/tmp" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: proc.exitCode, stderr: new TextDecoder().decode(proc.stderr) };
}

/** A PATH with the usual tools but deliberately no bun. */
const PATH_WITHOUT_BUN = ["/usr/bin", "/bin"];

describe("the source launcher refuses to run without bun", () => {
	it("names bun as the missing piece instead of failing as `exec: bun: not found`", () => {
		const { exitCode, stderr } = runLauncher(launcher, PATH_WITHOUT_BUN);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("bun is not on PATH");
		// The bare shell error is what the user used to get, with nothing else.
		expect(stderr).not.toContain("exec: bun");
	});

	it("explains that a source install runs through bun, which is why bun is required", () => {
		// A binary install has no such requirement, so "install bun" out of context
		// reads as a bug rather than a consequence of how this install works.
		const { stderr } = runLauncher(launcher, PATH_WITHOUT_BUN);
		expect(stderr).toContain("source install that runs veyyon through bun");
	});

	it("offers both ways out: fix bun, or switch to the standalone binary", () => {
		const { stderr } = runLauncher(launcher, PATH_WITHOUT_BUN);
		expect(stderr).toContain("https://bun.sh");
		expect(stderr).toContain("~/.bun/bin");
		expect(stderr).toContain("curl -fsSL https://get.veyyon.dev | sh");
	});
});

describe("the source launcher resolves its own location without forking", () => {
	it("says nothing about `dirname` even with nothing at all on PATH", () => {
		// It located itself with `$(dirname -- "$self")`. With `dirname` off PATH
		// that expands to the empty string, `cd ""` succeeds silently, and
		// scripts_dir ends up pointing at the user's current directory — so every
		// path derived from it is wrong and the eventual error names some
		// unrelated file. Parameter expansion cannot fail this way.
		const { stderr } = runLauncher(launcher, ["/nonexistent-for-test"]);
		expect(stderr).not.toContain("dirname");
		// It still gets far enough to give the real diagnosis.
		expect(stderr).toContain("bun is not on PATH");
	});

	it("resolves the checkout correctly when run from an unrelated directory", () => {
		// scripts_dir must come from the script's own path, never from the cwd.
		// If it came from the cwd, the missing-checkout check below would fire on
		// a checkout that is perfectly intact.
		const proc = Bun.spawnSync(["/bin/sh", launcher, "--version"], {
			cwd: os.tmpdir(),
			env: { PATH: PATH_WITHOUT_BUN.join(path.delimiter), HOME: process.env.HOME ?? "/tmp" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new TextDecoder().decode(proc.stderr);
		expect(stderr).toContain("bun is not on PATH");
		expect(stderr).not.toContain("checkout this command points at is incomplete");
	});

	it("fails loudly when a symlink in its own path cannot be read", () => {
		// `readlink` has no shell-builtin replacement, so it can still be missing.
		// Continuing with an empty result would build a path out of nothing; the
		// resolution has to stop instead (Law 10).
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-launcher-link-"));
		try {
			const link = path.join(root, "veyyon");
			fs.symlinkSync(launcher, link);
			const { exitCode, stderr } = runLauncher(link, ["/nonexistent-for-test"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("cannot resolve the symlink at");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("follows a symlink to the real script when readlink is available", () => {
		// The normal source install: PATH holds a symlink into ~/.veyyon/src.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-launcher-link-ok-"));
		try {
			const link = path.join(root, "veyyon");
			fs.symlinkSync(launcher, link);
			const { stderr } = runLauncher(link, PATH_WITHOUT_BUN);
			// Reaching the bun check at all proves the symlink resolved: the
			// checkout test that follows it passed against the real tree.
			expect(stderr).toContain("bun is not on PATH");
			expect(stderr).not.toContain("cannot resolve the symlink");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the source launcher refuses to run against a missing checkout", () => {
	/**
	 * A copy of the launcher in a directory shaped like a checkout but with no
	 * `src/cli.ts`, which is what a moved or half-deleted `~/.veyyon/src` leaves
	 * behind the PATH symlink.
	 */
	function withBrokenCheckout<T>(run: (script: string) => T): T {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-launcher-"));
		const scripts = path.join(root, "packages", "coding-agent", "scripts");
		fs.mkdirSync(scripts, { recursive: true });
		const copy = path.join(scripts, "veyyon");
		fs.copyFileSync(launcher, copy);
		fs.chmodSync(copy, 0o755);
		try {
			return run(copy);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	it("says the checkout is incomplete and names the file that is gone", () => {
		const bunDir = path.dirname(Bun.which("bun") ?? "/usr/bin");
		const result = withBrokenCheckout(script => runLauncher(script, [bunDir, "/usr/bin", "/bin"]));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("source checkout this command points at is incomplete");
		expect(result.stderr).toContain("src/cli.ts is missing");
	});

	// Both routes out, because either one may be the wrong advice: the checkout
	// may still be recoverable in place, or the user may want off source entirely.
	// This used to assert `sh -s -- --source`, a flag the installer deliberately
	// dropped because it cloned into `$HOME/.veyyon/src` behind the user's back
	// (see MANUAL_BUILD in scripts/install.sh), so it asserted a route that no
	// longer exists in the product.
	it("gives the reinstall command rather than leaving the user to guess", () => {
		const bunDir = path.dirname(Bun.which("bun") ?? "/usr/bin");
		const result = withBrokenCheckout(script => runLauncher(script, [bunDir, "/usr/bin", "/bin"]));
		expect(result.stderr).toContain("re-run 'bun run setup' in it");
		expect(result.stderr).toContain("curl -fsSL https://get.veyyon.dev | sh");
	});

	it("checks the checkout before trying to regenerate build artifacts", () => {
		// Regenerating inside a tree that is not there produces a second, more
		// confusing failure about a missing collab-web package. The order matters,
		// so assert the message the user actually gets is the checkout one.
		const bunDir = path.dirname(Bun.which("bun") ?? "/usr/bin");
		const result = withBrokenCheckout(script => runLauncher(script, [bunDir, "/usr/bin", "/bin"]));
		expect(result.stderr).not.toContain("gen:tool-views");
	});
});

/**
 * The Windows launcher (`scripts/veyyon.cmd`) is the same command for a Windows
 * source install, wired by `install.ps1 -Source`. It cannot be executed on the
 * Linux dev host, so its half of the contract is asserted from its text.
 */
describe("the Windows launcher guards the same two preconditions", () => {
	const cmd = fs.readFileSync(path.resolve(import.meta.dir, "..", "scripts", "veyyon.cmd"), "utf8");

	it("checks for bun before running anything that needs it", () => {
		expect(cmd).toContain("where bun >nul 2>&1");
		expect(cmd).toContain("bun is not on PATH");
		// Before the self-heal steps, which are themselves bun invocations.
		expect(cmd.indexOf("where bun")).toBeLessThan(cmd.indexOf("gen:tool-views"));
	});

	it("checks the checkout exists before handing bun a path into it", () => {
		expect(cmd).toContain('if not exist "%cli%"');
		expect(cmd).toContain("source checkout this command points at is incomplete");
		expect(cmd.indexOf('if not exist "%cli%"')).toBeLessThan(cmd.indexOf("gen:tool-views"));
	});

	it("points at the Windows recovery commands, not the POSIX ones", () => {
		// A `curl | sh` line on Windows is not a fix, it is a second problem.
		expect(cmd).toContain("irm https://veyyon.dev/install.ps1");
		expect(cmd).not.toContain("curl -fsSL");
	});

	it("keeps its stderr redirections real rather than echoing them", () => {
		// In a parenthesised cmd block `1>&2` is a redirection; `1^>^&2` is four
		// literal characters appended to the message. Both look plausible.
		expect(cmd).not.toContain("1^>^&2");
	});
});
