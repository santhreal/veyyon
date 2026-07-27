/**
 * A source checkout must not behave like a standalone binary.
 *
 * WHAT THE LOADER DECIDES ON. `detectCompiledBinary` returns true the moment
 * `native/embedded-addon.js` exports a populated object. That is deliberate and it is the
 * fix for issue 823: inside a Bun standalone binary neither `process.env.VEYYON_COMPILED`
 * nor a `__filename` bunfs marker is reliable, so the presence of the embedded metadata is
 * the only signal that always holds. It holds on ONE premise, stated in that test's own
 * header: the module is `null` in development and populated only inside a `--compile`
 * bundle.
 *
 * HOW THE PREMISE BROKE, AND WHAT IT COST. `bun run build:native` refreshes the embedded
 * archive so a later compile cannot load a stale addon, and it used to leave the metadata
 * module populated as well. From that moment the checkout claimed to be a compiled binary:
 * every `bun packages/coding-agent/src/cli.ts` took the embedded-archive branch and
 * extracted 290 MB into `$HOME/.veyyon/natives/<version>/` before it would even look at the
 * two perfectly good addons sitting in `packages/natives/native/`. The test suite spawns
 * the CLI with a fresh temp `HOME` many times per run, and nothing removed those homes, so
 * `/tmp` reached 38,600 stranded directories and 240 GB and the root filesystem filled.
 *
 * THE RULE NOW. A rebuild passes `--stub-metadata`, which writes the archive and leaves the
 * checked-in stub in place. Only `scripts/ci-release-build-binaries.ts` populates the
 * module, immediately before `bun build --compile`, and it resets it in a `finally`.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NATIVES_ROOT = path.join(import.meta.dir, "..");
const REPO_ROOT = path.join(NATIVES_ROOT, "..", "..");
const METADATA_MODULE = path.join(NATIVES_ROOT, "native", "embedded-addon.js");

describe("the embedded-addon metadata module", () => {
	/**
	 * THE CONTRACT ITSELF, checked against the working tree. Everything else in this file is
	 * about keeping this true; this is the thing that is true or is not.
	 *
	 * The failure is not subtle once you know it: `bun run gen:native:reset` restores the
	 * stub. What made it cost a filled disk is that nothing said so, and the symptom (a slow
	 * CLI and a growing `/tmp`) points nowhere near this file.
	 */
	it("exports null in a source checkout", async () => {
		const { embeddedAddon } = (await import(METADATA_MODULE)) as { embeddedAddon: unknown };

		expect(
			embeddedAddon,
			`${METADATA_MODULE} is populated, so this checkout claims to be a compiled binary and every ` +
				`CLI run in it stages ~290 MB into $HOME/.veyyon/natives. Restore the stub with ` +
				`\`bun run gen:native:reset\`.`,
		).toBeNull();
	});

	/**
	 * A populated module must never be COMMITTED either. The working-tree check above passes
	 * on a clean checkout of a bad commit, because then the populated module is what the
	 * checkout contains.
	 */
	it("is committed as the stub", async () => {
		const proc = Bun.spawn(["git", "show", "HEAD:packages/natives/native/embedded-addon.js"], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [committed, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

		expect(exitCode).toBe(0);
		expect(committed).toContain("export const embeddedAddon = null;");
	});
});

describe("what a rebuild leaves in the tree", () => {
	/**
	 * `build-native.ts` must refresh the archive WITHOUT populating the metadata module. The
	 * two artifacts have different lifetimes: the archive has to stay in step with
	 * `native/*.node` so a compiled binary cannot load a stale addon, while the metadata is
	 * what tells the loader it is compiled at all and belongs only inside the bundle.
	 */
	it("refreshes the archive with --stub-metadata", () => {
		const source = fs.readFileSync(path.join(NATIVES_ROOT, "scripts", "build-native.ts"), "utf8");

		expect(source).toContain("embed-native.ts");
		expect(source).toContain("--stub-metadata");
	});

	/**
	 * And the flag has to mean what the caller thinks it means: the metadata write is the one
	 * step it changes, and the archive write is not conditional on it.
	 */
	it("is a flag embed-native honours at the metadata write only", () => {
		const source = fs.readFileSync(path.join(NATIVES_ROOT, "scripts", "embed-native.ts"), "utf8");

		expect(source).toContain('const stubMetadata = process.argv.includes("--stub-metadata");');
		expect(source).toContain("await Bun.write(outputPath, stubMetadata ? stubContent : content);");
		expect(source).not.toContain("if (stubMetadata) process.exit(0);");
	});

	/**
	 * The release path is the ONE place allowed to populate it, and it must put it back even
	 * when the build throws. Without the `finally` a failed release leaves the machine in the
	 * exact state this whole file exists to prevent.
	 */
	it("is populated only by the release build, which resets it in a finally", () => {
		const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "ci-release-build-binaries.ts"), "utf8");
		const finallyIndex = source.indexOf("} finally {");

		expect(finallyIndex).toBeGreaterThan(-1);
		expect(source.slice(finallyIndex)).toContain("resetArtifacts()");
		expect(source).toContain('runCommand(["bun", "run", "gen:native:reset"], repoRoot)');
	});
});

describe("what a CLI run costs a fresh HOME", () => {
	/**
	 * THE MEASUREMENT, not the mechanism. Every assertion above is about a file's contents,
	 * and a future change could satisfy all of them while some other path stages the addon
	 * again. This one runs the CLI the way a test does and weighs what it left behind.
	 *
	 * `models` rather than `--version`, because the subcommand has to reach the native addon
	 * for the staging to happen at all: `--version` answers without loading it and passes this
	 * case on a checkout that stages 290 MB for every real command.
	 *
	 * WHAT IT DOES NOT WEIGH, and why the exclusion does not weaken it. `$HOME/.bun` is Bun's own
	 * install and transpile cache: the runtime writes it because this case redirects `HOME` at a
	 * `bun` process, it has nothing to do with veyyon, and it is 4.1 MB on a first run here. It used
	 * to be counted, which made this case fail at 4.4 MB on a perfectly clean checkout while
	 * reporting that the addon was being staged -- a true failure with a false explanation, which is
	 * worse than either. A compiled binary has no `.bun` directory at all, so the exclusion also
	 * makes the source measurement closer to the shipped one. Everything else in HOME is still
	 * weighed, including the `$HOME/.veyyon/natives/` the staged addon lands in, which is the whole
	 * point.
	 *
	 * MEASURED at 644 KB, all of it `$HOME/.veyyon`: the profile tree, `agent.db` and its WAL,
	 * `models.db`, and the shared-auth directory. Two megabytes is 145 times less than the staged
	 * addon and leaves room for a WAL that has grown, so it separates the two without pinning
	 * details that change with a schema.
	 */
	it("writes no more than two megabytes outside Bun's own cache", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-fresh-home-cost-"));
		const proc = Bun.spawn(["bun", path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts"), "models"], {
			cwd: REPO_ROOT,
			env: { ...process.env, HOME: home, NO_COLOR: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(0);

		let bytes = 0;
		const heaviest: Array<[string, number]> = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				// Bun's own cache, not veyyon's footprint. See the note above.
				if (entry.isDirectory() && full === path.join(home, ".bun")) continue;
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile()) {
					const size = fs.statSync(full).size;
					bytes += size;
					heaviest.push([path.relative(home, full), size]);
				}
			}
		};
		walk(home);
		heaviest.sort((a, b) => b[1] - a[1]);

		expect(
			bytes,
			`a single CLI invocation wrote ${(bytes / 1_048_576).toFixed(1)} MB into a fresh HOME, outside ` +
				`Bun's cache. If the heaviest entries below are under \`.veyyon/natives/\`, this checkout ` +
				`believes it is a compiled binary and is staging the addon: restore the stub with ` +
				`\`bun run gen:native:reset\`. Otherwise something new is writing to HOME on a first run.\n` +
				heaviest
					.slice(0, 10)
					.map(([name, size]) => `  ${(size / 1024).toFixed(0)} KB  ${name}`)
					.join("\n"),
		).toBeLessThan(2 * 1_048_576);
	}, 60_000);
});
