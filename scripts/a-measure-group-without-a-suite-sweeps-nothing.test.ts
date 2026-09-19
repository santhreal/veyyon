/**
 * Every desktop measure group is swept by a suite, and every suite sweeps a registered group.
 *
 * The dead-token sweep is split one suite per group of measures, because a
 * palette measure is invisible until the palette is open and re-rendering the
 * whole window once per key is not free. `GROUPS` in
 * `crates/veyyon-desktop-scene/tests/dead_token_probe/mod.rs` is the registry
 * that partition is keyed on, and
 * `a-every-measure-belongs-to-a-suite-that-sweeps-it.rs` pins both directions
 * between the measures and that registry: a measure no group claims fails, and
 * a group that claims no measure fails.
 *
 * THE HOLE THAT LEAVES. Neither assertion can see whether a suite for the group
 * exists, because a Rust integration test is its own binary and cannot
 * enumerate its siblings. Add `"surface.notices"` to `GROUPS` and write no
 * suite for it, and every existing test stays green while the measures under
 * that prefix are swept by nothing. The registry then states a coverage that
 * does not exist, which is worse than stating none.
 *
 * WHAT THIS CHECKS. The set of groups in `GROUPS` equals the set of groups
 * passed to `assert_every_measure_is_drawn` and
 * `assert_every_measure_is_drawn_except` across
 * `crates/veyyon-desktop-scene/tests/*.rs`, and no two suites sweep the same
 * group. Exact equality in both directions: a registered group with no suite
 * fails, and a suite sweeping a group nobody registered fails, which is what a
 * renamed prefix leaves behind on one side.
 *
 * It also reads the exemption rows. The second element of a row is the
 * repo-relative path of the suite that proves the measure where a raster
 * cannot see it, and this rejects a row that names the file it sits in, a
 * path that is not a file, and a suite whose source never names the measure.
 * All three shapes were written in one round: seven rows pointing at their own
 * file, for measures whose renderer never applied them, and three pointing at
 * the motion sweep, which reads `motion.*` only and so cannot observe a
 * `surface.transcript.*` key at all.
 *
 * WHAT IT DOES NOT CATCH. Whether the suite that names a group renders a state
 * that draws its measures, which is the suite's own assertion; whether the
 * suite an exemption names asserts anything about the measure, as opposed to
 * mentioning it; and a group named through a constant rather than a literal,
 * which reads here as no call at all and so fails closed rather than passing
 * quietly.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TESTS_DIR = path.join(REPO_ROOT, "crates/veyyon-desktop-scene/tests");
const PROBE = path.join(TESTS_DIR, "dead_token_probe/mod.rs");

/** The `GROUPS` array in the probe, as the prefixes it lists. */
export function registeredGroups(source: string): string[] {
	const block = /pub const GROUPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(source);
	if (!block) {
		throw new Error(`${PROBE} no longer declares a GROUPS array this gate can read`);
	}
	return [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

/** The groups a suite sweeps: the first argument of each sweep call. */
export function sweptGroups(source: string): string[] {
	const calls = /assert_every_measure_is_drawn(?:_except)?\(\s*"([^"]+)"/g;
	return [...source.matchAll(calls)].map(match => match[1]);
}

/** `values` with each entry kept once, in first-seen order. */
function unique(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) === index);
}

/** The top-level suite files, which are the ones cargo builds as test binaries. */
function suiteFiles(): string[] {
	return fs
		.readdirSync(TESTS_DIR, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(".rs"))
		.map(entry => path.join(TESTS_DIR, entry.name));
}

/** Every sweep call across the suites, with the file that makes it. */
function sweepCalls(): { group: string; file: string }[] {
	return suiteFiles().flatMap(file =>
		sweptGroups(fs.readFileSync(file, "utf8")).map(group => ({
			group,
			file: path.basename(file),
		})),
	);
}

/**
 * The exemption rows in one suite, as the measure and the suite each names as
 * proving it.
 *
 * A row is `("surface.shell.window_min_width_px", "crates/.../a-suite.rs")`:
 * the measure, then the file that proves it where a raster cannot.
 */
export function exemptionRows(source: string): { measure: string; provenBy: string }[] {
	const rows = /\(\s*"([a-z0-9_.]+)"\s*,\s*"([^"]+)"\s*,?\s*\)/g;
	return [...source.matchAll(rows)].map(match => ({ measure: match[1], provenBy: match[2] }));
}

describe("a measure group without a suite sweeps nothing", () => {
	it("sweeps every registered group, and registers every swept group", () => {
		const registered = unique(registeredGroups(fs.readFileSync(PROBE, "utf8"))).sort();
		const swept = unique(sweepCalls().map(call => call.group)).sort();
		expect(swept).toEqual(registered);
	});

	it("sweeps each group from exactly one suite", () => {
		const calls = sweepCalls();
		const twice = calls
			.filter((call, index) => calls.findIndex(other => other.group === call.group) !== index)
			.map(call => `${call.group} is swept again by ${call.file}`);
		expect(twice).toEqual([]);
	});

	it("names another suite in every exemption row", () => {
		const selfProving = suiteFiles().flatMap(file =>
			exemptionRows(fs.readFileSync(file, "utf8"))
				.filter(row => row.provenBy.endsWith(path.basename(file)))
				.map(row => `${row.measure} is exempted by ${path.basename(file)} and proven by nothing`),
		);
		expect(selfProving).toEqual([]);
	});

	it("names a suite that reaches the measure it excuses", () => {
		const unproven = suiteFiles().flatMap(file =>
			exemptionRows(fs.readFileSync(file, "utf8"))
				.filter(row => !row.provenBy.endsWith(path.basename(file)))
				.filter(row => {
					const named = path.join(REPO_ROOT, row.provenBy);
					if (!fs.existsSync(named)) {
						return true;
					}
					const key = row.measure.slice(row.measure.lastIndexOf(".") + 1);
					return !fs.readFileSync(named, "utf8").includes(key);
				})
				.map(row => `${row.measure} is exempted to ${row.provenBy}, which never names it`),
		);
		expect(unproven).toEqual([]);
	});

	it("reads a group out of the registry and a sweep call out of a suite", () => {
		expect(registeredGroups('pub const GROUPS: &[&str] = &[\n\t"a",\n\t"b.c",\n];')).toEqual(["a", "b.c"]);
		expect(sweptGroups('assert_every_measure_is_drawn("motion", observe);')).toEqual(["motion"]);
		expect(sweptGroups('assert_every_measure_is_drawn_except("surface.shell", observe, &[]);')).toEqual([
			"surface.shell",
		]);
		expect(
			exemptionRows(
				'const EXEMPT: &[(&str, &str)] = &[\n\t(\n\t\t"surface.shell.a_px",\n\t\t"crates/x/tests/a-b.rs",\n\t),\n];',
			),
		).toEqual([{ measure: "surface.shell.a_px", provenBy: "crates/x/tests/a-b.rs" }]);
		expect(sweptGroups("let group = GROUPS[0];")).toEqual([]);
	});
});
