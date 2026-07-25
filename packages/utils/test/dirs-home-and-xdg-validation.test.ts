import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, DIR_OVERRIDE_ENV_KEYS, resolveHomeDirOrThrow } from "@veyyon/utils";

/**
 * ENV-1 and ENV-2: the two environment variables every veyyon path is derived
 * from must be validated, not joined blind.
 *
 * `HOME` and the `XDG_*_HOME` trio decide where settings, sessions, caches, and
 * credentials live. A bad value there is not a bad path, it is every path, and
 * both failure modes look like success:
 *
 *  - an EMPTY home makes `path.join("", ".veyyon")` the RELATIVE path `.veyyon`,
 *    so state is created wherever the process happened to start, and the next
 *    run from a different directory finds an empty veyyon and starts over. No
 *    error is raised at any point.
 *  - `HOME=/` puts everything in `/.veyyon`, at the top of the filesystem.
 *  - a RELATIVE `XDG_CACHE_HOME` is resolved against the working directory, so
 *    the cache root moves with `cd`. The XDG base-directory spec requires these
 *    to be absolute and says an invalid one must be ignored, which veyyon now
 *    does — while SAYING so, because a silently discarded setting looks
 *    identical to one that was honored.
 *
 * The home cases are asserted against the validator directly rather than through
 * a spawned process, because `os.homedir()` is resolved once per process and
 * falls back to the passwd entry: assigning `HOME=""` in a child would NOT
 * produce an empty home on a normal machine, so a spawn-based test would quietly
 * assert nothing.
 */
describe("the home directory veyyon derives every path from", () => {
	afterEach(() => {
		spyOn(os, "homedir").mockRestore();
	});

	/** Force `os.homedir()` to a value the environment cannot reproduce. */
	function withHome(value: string): void {
		spyOn(os, "homedir").mockReturnValue(value);
	}

	test("an ordinary home is returned unchanged", () => {
		// The control. Without it, a validator that rejected everything would still
		// satisfy every assertion below.
		const home = path.join(os.tmpdir(), "some-user");
		withHome(home);

		expect(resolveHomeDirOrThrow()).toBe(home);
	});

	describe("refuses an unusable value instead of guessing", () => {
		test("an EMPTY home throws rather than resolving to a relative path", () => {
			// The dangerous one: no error today, and state scattered through every
			// directory the user ever launched from.
			withHome("");

			expect(() => resolveHomeDirOrThrow()).toThrow(/home directory/i);
		});

		test("a RELATIVE home throws", () => {
			// Same consequence as empty, reached through a different misconfiguration
			// (`HOME=veyyon-home` in a script that meant to build an absolute path).
			withHome("relative/home");

			expect(() => resolveHomeDirOrThrow()).toThrow();
		});

		test("the filesystem ROOT throws and names it", () => {
			// `HOME=/` is what a bare `su`, a misconfigured daemon, or a container
			// entrypoint leaves behind. Writing `/.veyyon` is never what was meant.
			withHome("/");

			expect(() => resolveHomeDirOrThrow()).toThrow(/filesystem root/);
		});
	});

	describe("the refusal is actionable", () => {
		test("names the variable to set", () => {
			// An error that says only "cannot determine your home directory" leaves
			// the user guessing which of several plausible knobs is wrong.
			withHome("");

			expect(() => resolveHomeDirOrThrow()).toThrow(/HOME/);
		});

		test("offers the explicit override as an alternative", () => {
			// Some environments genuinely cannot set a sane HOME (a service account,
			// a locked-down image). Those users need the other door named.
			withHome("");

			expect(() => resolveHomeDirOrThrow()).toThrow(/VEYYON_CONFIG_DIR/);
		});

		test("the root message names the directory that would have been created", () => {
			// Concrete beats abstract: seeing `/.veyyon` in the message is what makes
			// the problem obvious without reading any documentation.
			withHome("/");

			expect(() => resolveHomeDirOrThrow()).toThrow(/\/\.veyyon/);
		});
	});
});

/**
 * The XDG half runs in a real child process, because unlike `os.homedir()` these
 * variables ARE read from the live environment on every resolve, so a child is
 * both possible and more honest than a spy.
 */
describe("XDG base directories", () => {
	/** The relative value under test, and the directory created to make it real. */
	const RELATIVE_XDG = "relative-cache";
	const roots: string[] = [];
	afterEach(() => {
		for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	const UTILS_INDEX = path.resolve(import.meta.dir, "..", "src", "index.ts");

	/**
	 * Resolve the cache dir in a child with the given env, returning the resolved
	 * path and anything the process warned about.
	 *
	 * The child runs in a temp working directory that CONTAINS the relative XDG
	 * target, because the resolver only adopts an XDG root that exists. Without
	 * that, a relative value would be discarded for the wrong reason (nothing
	 * there) and the test would pass with the validation removed.
	 */
	async function resolveCacheDirIn(env: Record<string, string>): Promise<{ dir: string; warnings: string }> {
		const script = `
			import { getArgotCacheDir, refreshDirsFromEnv } from ${JSON.stringify(UTILS_INDEX)};
			const warnings = [];
			process.on("warning", w => warnings.push(String(w.message)));
			refreshDirsFromEnv();
			const dir = getArgotCacheDir();
			// Warnings are delivered on the next tick, so let them arrive first.
			await new Promise(resolve => setTimeout(resolve, 10));
			console.log(JSON.stringify({ dir, warnings: warnings.join("\\n") }));
		`;
		// A clean root: its own HOME (so no real profile or config is found) and a
		// working directory holding the relative XDG target the child is pointed at.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "xdg-validate-"));
		roots.push(root);
		const home = path.join(root, "home");
		const cwd = path.join(root, "cwd");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(cwd, RELATIVE_XDG, APP_NAME), { recursive: true });

		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...env };
		// A selected profile sends the resolver down the named-profile branch, where
		// XDG is keyed differently; drop every inherited dir override so the child
		// resolves from HOME and the XDG variable under test alone.
		for (const key of DIR_OVERRIDE_ENV_KEYS) delete childEnv[key];
		delete childEnv.VEYYON_PROFILE;

		const proc = Bun.spawn(["bun", "-e", script], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
		return JSON.parse(stdout.trim());
	}

	test.skipIf(process.platform !== "linux")("a RELATIVE XDG_CACHE_HOME is ignored, not joined", async () => {
		// The bug this row is about. Joined, it would resolve against the child's
		// working directory, so the same machine would use a different cache root
		// after any `cd` — and would create veyyon directories inside unrelated
		// project trees.
		const { dir } = await resolveCacheDirIn({ XDG_CACHE_HOME: RELATIVE_XDG });

		expect(path.isAbsolute(dir)).toBe(true);
		expect(dir).not.toContain(RELATIVE_XDG);
	});

	test.skipIf(process.platform !== "linux")("and the user is TOLD it was ignored", async () => {
		// Law 10. Dropping the value is what the spec requires; dropping it in
		// silence leaves the user believing a setting is in effect that is not.
		const { warnings } = await resolveCacheDirIn({ XDG_CACHE_HOME: RELATIVE_XDG });

		expect(warnings).toContain("XDG_CACHE_HOME");
		expect(warnings).toContain(RELATIVE_XDG);
		expect(warnings).toContain("absolute");
	});

	test.skipIf(process.platform !== "linux")("an ABSOLUTE XDG_CACHE_HOME warns about nothing", async () => {
		// The control for the warning: an ordinary, valid configuration must be
		// quiet, or the warning becomes noise and stops being read.
		const { warnings } = await resolveCacheDirIn({ XDG_CACHE_HOME: path.join(os.tmpdir(), "xdg-cache-absolute") });

		expect(warnings).not.toContain("XDG_CACHE_HOME");
	});
});
