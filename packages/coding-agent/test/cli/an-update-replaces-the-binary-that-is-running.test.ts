/**
 * An update replaces the binary that is RUNNING, not whichever copy of the command name
 * PATH happens to resolve first.
 *
 * WHY THIS SUITE EXISTS. The target was `$which("veyyon")`, and that is a different
 * question from "which file is this process". Measured, end to end: a 1.0.47 release
 * binary installed under a sandbox home was run as
 * `/tmp/vhome/.local/bin/veyyon update`. It reported `New version available: 1.0.48`,
 * `Checksum verified`, `Updated to 1.0.48` — and afterwards
 * `/tmp/vhome/.local/bin/veyyon --version` still said 1.0.47, while
 * `/home/…/.local/bin/veyyon`, a different install nobody had named, held the 1.0.48
 * release asset with a fresh mtime. Digests confirmed both halves.
 *
 * Both failures are silent, and the machine that produces them is ordinary: the
 * installer itself prints a warning, by name, whenever it installs somewhere that is not
 * first on PATH. `verifyBinaryVersion` already refuses to re-resolve the name for the
 * post-swap check (see `update-verify-binary-version.test.ts`) and that reasoning was
 * written down there; it was never applied to choosing the target in the first place, so
 * a verification bound to the wrong file passed happily.
 *
 * The class this closes: every reading of "which install is this" comes from the running
 * process when the process is the shipped binary, and PATH is the fallback for the one
 * case that cannot answer — bun running a source checkout, which updates by advancing
 * that checkout anyway.
 *
 * What it does not catch: an install whose binary sits somewhere the process cannot
 * write (a `sudo`-installed `/usr/local/bin`). That fails loudly with the OS error at
 * the swap, which is the same behavior it had before, and no choice of target avoids it.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	chooseUpdateTargetPath,
	type InstallLocation,
	readInstallLocation,
	resolveUpdateMethod,
} from "@veyyon/coding-agent/cli/update-cli";

const RUNNING = path.join(path.sep, "home", "u", ".local", "bin", "veyyon");
const DECOY = path.join(path.sep, "usr", "local", "bin", "veyyon");

function location(overrides: Partial<InstallLocation> = {}): InstallLocation {
	return { compiled: true, execPath: RUNNING, onPath: DECOY, ...overrides };
}

describe("choosing which file an update replaces", () => {
	/**
	 * THE incident. Another copy of the name comes first in PATH, and the update must
	 * still land on the binary the user actually ran.
	 */
	test("a compiled binary updates itself, not an older copy earlier on PATH", () => {
		expect(chooseUpdateTargetPath(location())).toBe(RUNNING);
	});

	/**
	 * The same install with nothing on PATH at all. This used to throw "Could not resolve
	 * veyyon binary path in PATH" — a running binary told it could not find itself,
	 * which is what an install into a directory the shell has not picked up looks like.
	 */
	test("a compiled binary updates itself when the name resolves nowhere", () => {
		expect(chooseUpdateTargetPath(location({ onPath: undefined }))).toBe(RUNNING);
	});

	/** And when PATH agrees, the answer is the same file either way. */
	test("a compiled binary that is also first on PATH resolves to itself", () => {
		expect(chooseUpdateTargetPath(location({ onPath: RUNNING }))).toBe(RUNNING);
	});

	/**
	 * The fallback that must survive: bun running a source checkout has bun at
	 * `execPath`, and a checkout is updated by fast-forwarding it. Taking `execPath`
	 * there would aim a binary swap at the bun executable.
	 */
	test("a source or dev run falls back to the launcher on PATH", () => {
		const launcher = path.join(
			path.sep,
			"home",
			"u",
			".veyyon",
			"src",
			"packages",
			"coding-agent",
			"scripts",
			"veyyon",
		);
		const target = chooseUpdateTargetPath({
			compiled: false,
			execPath: path.join(path.sep, "usr", "bin", "bun"),
			onPath: launcher,
		});

		expect(target).toBe(launcher);
		// And it is still classified as the install it is, which is what keeps a source
		// checkout from being overwritten by a downloaded binary.
		expect(resolveUpdateMethod(target as string, () => "")).toBe("source");
	});

	/** Nothing to update, and the caller has to be told rather than handed a guess. */
	test("a dev run with nothing on PATH resolves to nothing", () => {
		expect(
			chooseUpdateTargetPath({
				compiled: false,
				execPath: path.join(path.sep, "usr", "bin", "bun"),
				onPath: undefined,
			}),
		).toBeUndefined();
	});

	/**
	 * An empty or whitespace `execPath` is not an answer. Treating it as one would write
	 * the release binary to a relative path in the working directory, and the PATH
	 * reading is still there to be used.
	 */
	test.each(["", "   "])("a blank execPath does not become the target", execPath => {
		expect(chooseUpdateTargetPath(location({ execPath }))).toBe(DECOY);
	});

	/**
	 * Windows hands back an extended-length path for a deep install, and that prefix
	 * reaches the user in every message this file writes (the backup path, the rollback
	 * instructions) as well as into `$` when the swapped binary is run for verification.
	 * The platform is passed rather than read, because the strip is a no-op off win32 and
	 * this contract would otherwise be asserted only by a Windows runner.
	 */
	test("a Windows extended-length prefix is stripped from the target", () => {
		const target = chooseUpdateTargetPath(location({ execPath: "\\\\?\\C:\\Users\\u\\veyyon\\veyyon.exe" }), "win32");

		expect(target).toBe("C:\\Users\\u\\veyyon\\veyyon.exe");
	});

	/** Off Windows the same bytes are a legitimate (if strange) filename and stay whole. */
	test("a path that only looks Windows-like is untouched off win32", () => {
		const execPath = "\\\\?\\C:\\Users\\u\\veyyon\\veyyon.exe";

		expect(chooseUpdateTargetPath(location({ execPath }), "linux")).toBe(execPath);
	});
});

describe("reading the location off the live process", () => {
	/**
	 * The wiring, so the decision above is not a pure function nobody calls with real
	 * values. Under `bun test` this process is bun running sources, which is exactly the
	 * fallback reading: `compiled` is false and the target comes from PATH.
	 */
	test("a source run reports itself as not compiled", () => {
		const where = readInstallLocation();

		expect(where.compiled).toBe(false);
		expect(where.execPath).toBe(process.execPath);
		expect(chooseUpdateTargetPath(where)).toBe(where.onPath);
	});

	/**
	 * And the compiled reading, through the env seam `isCompiledBinary` honors, so the
	 * production path is observed choosing `execPath` rather than the PATH answer. The
	 * expectation is derived from `process.execPath` instead of written down, because a
	 * literal here would pass while the reading was wired to something else.
	 */
	test("a compiled run reports its own executable and targets it", () => {
		const previous = process.env.VEYYON_COMPILED;
		process.env.VEYYON_COMPILED = "1";
		try {
			const where = readInstallLocation();

			expect(where.compiled).toBe(true);
			expect(where.execPath).toBe(process.execPath);
			expect(chooseUpdateTargetPath(where)).toBe(process.execPath);
		} finally {
			if (previous === undefined) delete process.env.VEYYON_COMPILED;
			else process.env.VEYYON_COMPILED = previous;
		}
	});
});
