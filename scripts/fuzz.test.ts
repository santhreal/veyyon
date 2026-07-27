/**
 * The driver for the fuzzing suite.
 *
 * These tests are about the ways a fuzz runner fails without telling you. It can
 * run fewer targets than you asked for (a name it did not recognize, silently
 * dropped), run for less time than you asked for (a malformed `--seconds`
 * quietly falling back to the sixty-second default), or lose a target entirely
 * because the list it iterates drifted from the manifest cargo actually builds.
 * Every one of those looks like a clean, successful campaign from the outside,
 * and every one means code you believe was fuzzed never was.
 *
 * So the manifest parse is pinned from both sides with real target names, and
 * every refusal is asserted as a refusal rather than as a default.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	COMMANDS,
	DEFAULT_RSS_LIMIT_MB,
	DEFAULT_SECONDS,
	fuzzDir,
	isCommand,
	libfuzzerArgs,
	numericFlag,
	parseFlags,
	parseTargetNames,
	readTargetNames,
	resolveBuildJobs,
	resolveJobs,
	selectTargets,
	UsageError,
} from "./fuzz";

describe("parseTargetNames", () => {
	/**
	 * The real manifest, read from disk. This is the case that matters: it is the
	 * one that fails when somebody adds a `[[bin]]` in a shape the line parser
	 * does not handle, which is precisely when the new target silently stops
	 * being fuzzed.
	 *
	 * ADD YOUR NEW TARGET TO THIS LIST, in the order the manifest declares it.
	 * The list is deliberately hand-written rather than derived, because a
	 * derived one would agree with a broken parser. It went stale once
	 * (`minimizer_detect` and `minimizer_primitives` were registered, documented,
	 * and left out of here), which left this gate red, so a failure that names
	 * only missing entries means exactly that: copy them in.
	 */
	it("finds every target in the manifest cargo builds", () => {
		const manifest = fs.readFileSync(path.join(fuzzDir, "Cargo.toml"), "utf-8");
		const names = parseTargetNames(manifest);

		expect(names).toEqual([
			"walker_path_order",
			"walker_glob",
			"ast_apply_edits",
			"ast_parse_and_match",
			"minimizer_filters",
			"minimizer_lint_condense",
			"keys_parse",
			"glob_patterns",
			"ast_block_range",
			"text_measure",
			"diff_kernel_unified",
			"iso_git_diff_parse",
			"uu_diff_argv",
			"uutils_ctx_scope",
			"uu_grep_argv",
			"minimizer_detect",
			"minimizer_primitives",
		]);
	});

	/**
	 * Every name found must correspond to a file cargo can compile. A `[[bin]]`
	 * whose `path` was never created builds fine until you run it, and the runner
	 * would report it as a target that found nothing.
	 */
	it("names only targets whose source files exist", () => {
		for (const name of readTargetNames()) {
			const source = path.join(fuzzDir, "fuzz_targets", `${name}.rs`);
			expect(fs.existsSync(source)).toBe(true);
		}
	});

	/**
	 * The converse, and the one that catches a target added to the directory but
	 * never registered. Cargo does not build it, so it never runs, and nothing
	 * anywhere reports that the file is dead.
	 */
	it("registers every target file present on disk", () => {
		const onDisk = fs
			.readdirSync(path.join(fuzzDir, "fuzz_targets"))
			.filter(entry => entry.endsWith(".rs"))
			.map(entry => entry.slice(0, -".rs".length))
			.sort();

		expect(readTargetNames().sort()).toEqual(onDisk);
	});

	/**
	 * The documentation names exactly the targets that exist.
	 *
	 * WHY THIS IS A GATE AND NOT A NICETY. `docs/internal/fuzzing.md` carries the only description
	 * of what each target covers, and it is what somebody reads before deciding whether a surface is
	 * already fuzzed. A target missing from that table reads as a surface nobody has covered, and
	 * gets covered twice; a row left behind for a deleted target reads as coverage that does not
	 * exist, which is worse, because it is the reason a real gap goes unnoticed.
	 */
	it("documents exactly the targets the manifest registers", () => {
		const docs = fs.readFileSync(path.join(fuzzDir, "..", "docs", "internal", "fuzzing.md"), "utf-8");
		const documented = [...docs.matchAll(/^\| `([a-z0-9_]+)` \| `veyyon-[a-z-]+` \|/gm)].map(match => match[1]);

		expect(documented.sort()).toEqual(readTargetNames().sort());
	});

	/** `name` outside a `[[bin]]` table is the package name, not a target. */
	it("ignores the package name and other tables", () => {
		const manifest = ["[package]", 'name = "veyyon-fuzz"', "", "[[bin]]", 'name = "real_target"'].join("\n");

		expect(parseTargetNames(manifest)).toEqual(["real_target"]);
	});

	/** A `[[bin]]` table ends where the next table begins. */
	it("stops collecting at the next table header", () => {
		const manifest = ["[[bin]]", 'name = "first"', "", "[dependencies]", 'name = "not-a-target"'].join("\n");

		expect(parseTargetNames(manifest)).toEqual(["first"]);
	});

	/**
	 * Comments are prose and may say anything. The manifest in this repo opens
	 * with a comment block explaining the workspace split, and a parser that read
	 * bracketed text inside it would mis-track which table it is in.
	 */
	it("ignores commented-out targets and bracketed prose in comments", () => {
		const manifest = [
			"# The [[bin]] entries below are the targets.",
			'# name = "commented_out"',
			"[[bin]]",
			'name = "live"',
		].join("\n");

		expect(parseTargetNames(manifest)).toEqual(["live"]);
	});

	/**
	 * An empty result is refused rather than returned. A manifest that parsed to
	 * zero targets would make `run` report "all 0 targets finished with no
	 * findings", which is the most misleading possible success.
	 */
	it("refuses a manifest with no targets", () => {
		expect(() => parseTargetNames("[package]\nname = 'x'\n")).toThrow(UsageError);
	});
});

describe("selectTargets", () => {
	const known = ["alpha", "beta", "gamma"];

	/** No names means the whole suite, which is what an unattended run wants. */
	it("defaults to every known target", () => {
		expect(selectTargets([], known)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("keeps the requested order and only the requested targets", () => {
		expect(selectTargets(["gamma", "alpha"], known)).toEqual(["gamma", "alpha"]);
	});

	/**
	 * The important one. A typo'd name must stop the run, not quietly reduce it:
	 * `fuzz run walker_path_ordr` running nothing and exiting 0 reads identically
	 * to a clean campaign.
	 */
	it("refuses an unknown target instead of skipping it", () => {
		expect(() => selectTargets(["alpha", "delta"], known)).toThrow(UsageError);
	});

	/** The message has to name both the bad input and the valid set. */
	it("reports which name was unknown and what the valid ones are", () => {
		expect(() => selectTargets(["delta"], known)).toThrow(/delta[\s\S]*alpha, beta, gamma/);
	});

	/** The returned array is a copy; a caller draining it must not empty the source. */
	it("does not hand back the caller's array", () => {
		const selected = selectTargets([], known);
		selected.pop();

		expect(known).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("parseFlags", () => {
	it("reads a value after the first equals sign", () => {
		expect(parseFlags(["--seconds=3600"]).get("seconds")).toBe("3600");
	});

	/** A bare flag is present-and-true, which is how a boolean switch reads. */
	it("treats a bare flag as true", () => {
		expect(parseFlags(["--verbose"]).get("verbose")).toBe("true");
	});

	/** Positional arguments are target names and must not become flags. */
	it("ignores positional arguments", () => {
		expect([...parseFlags(["run", "walker_glob", "--jobs=2"]).keys()]).toEqual(["jobs"]);
	});

	/** Only the first equals sign separates; the rest belongs to the value. */
	it("keeps equals signs inside the value", () => {
		expect(parseFlags(["--extra=-max_len=64"]).get("extra")).toBe("-max_len=64");
	});

	/** An explicitly empty value is preserved so `numericFlag` can reject it. */
	it("preserves an empty value rather than defaulting it", () => {
		expect(parseFlags(["--seconds="]).get("seconds")).toBe("");
	});
});

describe("numericFlag", () => {
	it("returns the fallback when the flag is absent", () => {
		expect(numericFlag(new Map(), "seconds", DEFAULT_SECONDS)).toBe(60);
	});

	it("parses a positive number", () => {
		expect(numericFlag(new Map([["seconds", "3600"]]), "seconds", DEFAULT_SECONDS)).toBe(3600);
	});

	/**
	 * The whole reason this function exists. `--seconds=6O` with a capital letter
	 * O parses as NaN, and a fallback to sixty seconds turns an intended one-hour
	 * campaign into a smoke test that reports success. Refusing is the only safe
	 * behaviour, because the operator is not watching.
	 */
	it.each([
		["6O", "a letter O for a zero"],
		["", "an empty value"],
		["abc", "a word"],
		["0", "zero, which would run for no time at all"],
		["-30", "a negative duration"],
		["Infinity", "a non-finite number"],
		["NaN", "NaN"],
	])("refuses %j (%s) rather than falling back", raw => {
		expect(() => numericFlag(new Map([["seconds", raw]]), "seconds", DEFAULT_SECONDS)).toThrow(UsageError);
	});

	/** A fractional value is meaningful for `--seconds` and must survive. */
	it("accepts a fractional value", () => {
		expect(numericFlag(new Map([["seconds", "0.5"]]), "seconds", DEFAULT_SECONDS)).toBe(0.5);
	});
});

describe("resolveJobs", () => {
	/**
	 * Half the cores by default, so the sanitizer runtime is not oversubscribed.
	 * Twenty targets on thirty-two cores, because with fewer targets than half the
	 * cores the clamp below decides instead and this case would prove nothing.
	 */
	it("defaults to half the cores", () => {
		expect(resolveJobs(undefined, 20, 32)).toBe(16);
	});

	/** Never more parallel processes than there are targets to run. */
	it("never exceeds the target count", () => {
		expect(resolveJobs(undefined, 3, 32)).toBe(3);
	});

	/** A single-core machine still runs one target rather than zero. */
	it("stays at one on a single-core machine", () => {
		expect(resolveJobs(undefined, 6, 1)).toBe(1);
	});

	it("honours an explicit request", () => {
		expect(resolveJobs(4, 6, 32)).toBe(4);
	});

	/** An explicit request above the target count is still clamped. */
	it("clamps an explicit request to the target count", () => {
		expect(resolveJobs(64, 6, 32)).toBe(6);
	});
});

describe("resolveBuildJobs", () => {
	/**
	 * WHY THIS IS NOT `resolveJobs`.
	 *
	 * A single-target run once died before the fuzzer started: `cargo fuzz build`
	 * with no target name compiles every target, which drags the vendored uutils
	 * tree through a sanitizer build at one codegen unit, and rustc was killed by
	 * signal 9 twice (`uu_printenv`, `uu_head`). The runner reported "Build
	 * failed; not running any targets" for a request that touched none of it.
	 *
	 * Two things came out of that: build only the named targets, and do not run
	 * as many compilers as fuzzers. A fuzzer process is small and CPU-bound; a
	 * sanitizer build is large and memory-bound, so the number that keeps every
	 * core busy during a run is the number that gets rustc killed during a build.
	 * These cases pin the second half, and they are separate from `resolveJobs`
	 * on purpose: reusing that number is exactly the bug.
	 */
	it("defaults to half the cores", () => {
		expect(resolveBuildJobs(undefined, 32)).toBe(16);
	});

	/**
	 * NOT clamped to the target count, unlike `resolveJobs`.
	 *
	 * Building one target is still a build of its whole dependency tree, so one
	 * target does not mean one compiler. Clamping here would serialize every
	 * single-target build to one job and make the common invocation the slowest.
	 */
	it("does not clamp to the number of targets", () => {
		expect(resolveBuildJobs(undefined, 32)).toBe(16);
		expect(resolveBuildJobs(8, 32)).toBe(8);
	});

	/** A single-core machine still builds with one job rather than zero. */
	it("stays at one on a single-core machine", () => {
		expect(resolveBuildJobs(undefined, 1)).toBe(1);
	});

	/** Someone who knows their machine can ask for more than half the cores. */
	it("honours an explicit request above the default", () => {
		expect(resolveBuildJobs(24, 32)).toBe(24);
	});
});

describe("libfuzzerArgs", () => {
	/**
	 * Pinned as exact bytes. These are the flags that decide how long the campaign
	 * runs and when libFuzzer calls an allocation a finding; a rename or a
	 * misspelling is accepted silently by libFuzzer's argument parser in some
	 * versions and the run then uses defaults nobody asked for.
	 */
	it("passes the time limit, the memory ceiling, and the final stats flag", () => {
		expect(libfuzzerArgs(3600, 4096)).toEqual(["-max_total_time=3600", "-rss_limit_mb=4096", "-print_final_stats=1"]);
	});

	it("uses the documented memory default", () => {
		expect(libfuzzerArgs(DEFAULT_SECONDS, DEFAULT_RSS_LIMIT_MB)).toContain(`-rss_limit_mb=${DEFAULT_RSS_LIMIT_MB}`);
	});
});

describe("isCommand", () => {
	it.each([...COMMANDS])("accepts %s", command => {
		expect(isCommand(command)).toBe(true);
	});

	it.each([undefined, "", "runn", "help", "--seconds=60"])("rejects %j", value => {
		expect(isCommand(value as string | undefined)).toBe(false);
	});
});

describe("sanitizer builds are capped", () => {
	/**
	 * Every cargo invocation that COMPILES passes a job cap.
	 *
	 * WHY THIS IS A SOURCE CHECK. `resolveBuildJobs` is tested above and was already correct; the
	 * bug was that `coverage` never called it. A coverage build adds `-Cinstrument-coverage` on top
	 * of the sanitizer flags and still compiles at `codegen-units=1`, so uncapped it took every core
	 * and rustc was killed by signal 9 partway through the dependency graph. That surfaces as
	 * `could not compile notify`, which reads as a broken toolchain rather than as an out-of-memory,
	 * and there is no behavioural assertion that catches it short of running the build.
	 *
	 * The check is on the call sites because the omission is a missing ARGUMENT, not a wrong value.
	 */
	it("passes a job count to every build and coverage invocation", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "fuzz.ts"), "utf8");
		const uncapped = [...source.matchAll(/runCargoFuzz\(\[\s*"(build|coverage)"[^\]]*\]\s*\)/g)].map(
			match => match[0],
		);

		expect(uncapped, "compiling cargo-fuzz call with no build-jobs cap — pass resolveBuildJobs(...)").toEqual([]);
	});

	/** The cap reaches cargo as the variable cargo reads, not as an unsupported `-j` flag. */
	it("caps through CARGO_BUILD_JOBS rather than a cargo-fuzz flag", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "fuzz.ts"), "utf8");

		expect(source).toContain("CARGO_BUILD_JOBS");
		// `cargo fuzz` has no `-j`, so a build that tried to pass one would fail on argument parsing.
		expect(source).not.toMatch(/runCargoFuzz\(\[[^\]]*"-j"/);
	});
});
