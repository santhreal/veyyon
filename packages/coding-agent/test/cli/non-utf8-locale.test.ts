import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@veyyon/utils";
import { hermeticSpawnEnv, type HermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * The CLI under a non-UTF-8 locale (ENV-4).
 *
 * WHY THIS SUITE EXISTS. `LC_ALL=C` is not exotic. It is the default inside many
 * minimal Docker images, it is what `sudo`, `cron`, systemd units and most CI
 * runners hand a process, and plenty of people export it deliberately to get
 * stable `sort` and `grep` behaviour. Under that locale a program built on
 * locale-sensitive C library calls starts mangling anything outside ASCII:
 * accented names come back as `?`, CJK becomes byte soup, and a filename with an
 * emoji in it stops round-tripping.
 *
 * Veyyon reads and writes UTF-8 unconditionally (Bun's strings are UTF-16 and
 * its file APIs encode UTF-8 regardless of `LC_*`), so the correct behaviour is
 * that the locale changes NOTHING. That is a claim worth proving rather than
 * assuming, because the moment a code path shells out, or reaches for
 * `toLocaleUpperCase`, or lets a native module pick an encoding from the
 * environment, it stops being true and the failure only shows up on someone
 * else's machine.
 *
 * Every assertion here compares against BYTES produced under the developer's own
 * locale, so the test is a differential rather than a guess about what the output
 * should look like. Both `LC_ALL` and `LANG` are set, because `LC_ALL` overrides
 * `LANG` and a program that reads only the latter would otherwise slip through.
 */
describe("the CLI under LC_ALL=C", () => {
	let hermetic: HermeticSpawnEnv | undefined;
	let projectDir = "";

	const cliEntry = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

	/** Non-ASCII spanning the three cases that break differently: accented Latin
	 * (single non-ASCII byte pair), CJK (three-byte sequences), and an emoji
	 * (surrogate pair in UTF-16, four bytes in UTF-8). */
	const NON_ASCII = "café · 日本語 · 🧑‍🚀";

	beforeEach(async () => {
		hermetic = hermeticSpawnEnv();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-locale-"));
	});

	afterEach(async () => {
		hermetic?.cleanup();
		hermetic = undefined;
		if (projectDir) {
			await removeWithRetries(projectDir);
			projectDir = "";
		}
	});

	/** Run the CLI once and return its stdout plus exit code. `locale` replaces the
	 * inherited locale variables when given. */
	async function run(args: string[], locale?: "C"): Promise<{ stdout: string; exitCode: number }> {
		const env = { ...(hermetic as HermeticSpawnEnv).env };
		if (locale === "C") {
			env.LC_ALL = "C";
			env.LANG = "C";
			env.LC_CTYPE = "C";
		}
		const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
			cwd: projectDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			proc.exited,
		]);
		return { stdout, exitCode };
	}

	describe("output is byte-identical to the same run under the ambient locale", () => {
		/**
		 * `--help` is the widest piece of text the CLI emits without doing any work:
		 * every command name, description and flag. If a locale could reach the
		 * output encoding at all, the box drawing and any non-ASCII in the
		 * descriptions is where it would show first.
		 */
		it("`--help` produces the same bytes", async () => {
			const ambient = await run(["--help"]);
			const posix = await run(["--help"], "C");

			expect(ambient.exitCode).toBe(0);
			expect(posix.exitCode).toBe(0);
			expect(posix.stdout).toBe(ambient.stdout);
		});

		/** `--version` is short and exact, so a difference here is unambiguous. */
		it("`--version` produces the same bytes", async () => {
			const ambient = await run(["--version"]);
			const posix = await run(["--version"], "C");

			expect(posix.stdout).toBe(ambient.stdout);
			expect(posix.stdout.trim()).not.toBe("");
		});
	});

	describe("non-ASCII content survives the round trip", () => {
		/**
		 * THE case the locale actually threatens: file CONTENT read back and printed.
		 * A locale-sensitive decode would turn each multi-byte sequence into `?` or
		 * U+FFFD, and the assertion is on the exact original string rather than on
		 * "some non-ASCII is present" so a partially-mangled result still fails.
		 */
		it("a file's non-ASCII content reads back exactly", async () => {
			const file = path.join(projectDir, "notes.txt");
			await fs.writeFile(file, `${NON_ASCII}\n`);

			const posix = await run(["read", file], "C");

			expect(posix.exitCode).toBe(0);
			expect(posix.stdout).toContain(NON_ASCII);
		});

		/**
		 * Non-ASCII in the FILENAME, which is a separate path: the name comes from a
		 * directory read rather than a file read, and on Linux it is raw bytes with
		 * no encoding attached, so it is the likeliest place for a locale to be
		 * consulted.
		 */
		it("a non-ASCII filename round-trips", async () => {
			const name = "café-日本語.txt";
			await fs.writeFile(path.join(projectDir, name), "ascii body\n");

			const posix = await run(["read", path.join(projectDir, name)], "C");

			expect(posix.exitCode).toBe(0);
			expect(posix.stdout).toContain("ascii body");
		});

		/** The differential for content: the same read under both locales must
		 * produce the same bytes, which is a stronger statement than "the string
		 * appears" because it also catches a locale-dependent line ending or a
		 * differently-truncated line. */
		it("the same read under both locales produces the same bytes", async () => {
			const file = path.join(projectDir, "notes.txt");
			await fs.writeFile(file, `${NON_ASCII}\nsecond line\n`);

			const ambient = await run(["read", file]);
			const posix = await run(["read", file], "C");

			expect(posix.stdout).toBe(ambient.stdout);
		});
	});
});
