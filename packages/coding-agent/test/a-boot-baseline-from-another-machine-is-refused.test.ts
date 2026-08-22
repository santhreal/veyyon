// WHY: the boot guard compared a median against whatever number sat in
// `bench/throughput/boot-baseline.json`, with nothing recorded about where that
// number came from. A baseline captured on a laptop reads as a 40% regression on
// a workstation, a slower CPU reads as a fix, and a baseline taken over 10 runs
// was compared against one taken over 20. The class this closes is a comparison
// between two medians that were not measured under the same conditions: every
// fact the comparison rests on travels with the baseline, disagreement on any of
// them is a refusal naming the field, and a baseline written by an older guard
// is refused rather than read leniently.
//
// The variant space is the fingerprint itself, read from `COMPARED_FIELDS` at
// run time, so a field added to the type is either compared or named in the
// pinned recorded-only list.
//
// What it does not catch: whether the fingerprint measures the right facts —
// two hosts with identical CPU model, hostname and Bun version but different
// thermal or power state still compare, and no field can see that.
import { describe, expect, it } from "bun:test";
import {
	BASELINE_VERSION,
	type BaselineFile,
	type BenchFingerprint,
	COMPARED_FIELDS,
	decide,
	MIN_RUNS,
	medianOf,
	RECORDED_ONLY_FIELDS,
	refusals,
	THRESHOLD,
} from "../scripts/bench-guard-decision";

const FINGERPRINT: BenchFingerprint = {
	platform: "linux",
	arch: "x64",
	cpu: "AMD Ryzen 9 9950X 16-Core Processor",
	host: "workstation",
	runtime: "bun 1.4.0",
	command: "VEYYON_TIMING=x VEYYON_STRICT_EDIT_MODE=1 bun src/cli.ts",
	isolatedHome: true,
	runs: MIN_RUNS,
};

function baseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
	return {
		version: BASELINE_VERSION,
		median: 0.4,
		fingerprint: { ...FINGERPRINT },
		revision: "a".repeat(40),
		dirty: false,
		capturedAt: "2026-08-22T00:00:00.000Z",
		hyperfine: {},
		...overrides,
	};
}

/** A value of the same type as `field`'s, guaranteed different. */
function otherValue(field: keyof BenchFingerprint): string | number | boolean {
	const value = FINGERPRINT[field];
	if (typeof value === "boolean") return !value;
	if (typeof value === "number") return value + 7;
	return `${value}-elsewhere`;
}

describe("boot baseline comparability", () => {
	it("compares every fingerprint field that can move a median", () => {
		// Each compared field, swept from source: changing it alone must refuse,
		// and the refusal must name the field so the reader knows what differed.
		for (const field of COMPARED_FIELDS) {
			const candidate = { ...FINGERPRINT, [field]: otherValue(field) } as BenchFingerprint;
			const reasons = refusals(baseline(), candidate);
			expect(reasons.length, `${field} did not refuse`).toBeGreaterThan(0);
			expect(reasons.join("\n")).toContain(field);
			expect(decide(baseline(), candidate, 0.4).kind).toBe("refused");
		}
	});

	it("compares or excuses every field the fingerprint carries, and nothing else", () => {
		// The sweep above reads its list from the source, so dropping a field
		// from that list would also drop it from the sweep. These two pins are
		// what make a quietly uncompared field impossible: the compared set is
		// exact, and every key the fingerprint carries has to appear in one of
		// the two lists.
		expect([...COMPARED_FIELDS]).toEqual(["platform", "arch", "cpu", "host", "runtime", "command", "isolatedHome"]);
		expect([...RECORDED_ONLY_FIELDS]).toEqual(["revision", "dirty", "runs"]);
		const accounted = new Set<string>([...COMPARED_FIELDS, ...RECORDED_ONLY_FIELDS]);
		const unaccounted = Object.keys(FINGERPRINT).filter(key => !accounted.has(key));
		expect(unaccounted).toEqual([]);
		// And a field added to the type breaks the build here rather than
		// slipping past a fixture nobody updated.
		const exhaustive: Record<keyof BenchFingerprint, true> = {
			platform: true,
			arch: true,
			cpu: true,
			host: true,
			runtime: true,
			command: true,
			isolatedHome: true,
			runs: true,
		};
		expect(Object.keys(exhaustive).sort()).toEqual(Object.keys(FINGERPRINT).sort());

		// The revision differing is the normal case — candidate code against a
		// baseline commit — so it must not refuse.
		expect(refusals(baseline({ revision: "b".repeat(40) }), { ...FINGERPRINT })).toEqual([]);
		expect(refusals(baseline({ dirty: true }), { ...FINGERPRINT })).toEqual([]);
	});

	it("refuses a baseline written by another version of the guard", () => {
		const reasons = refusals(baseline({ version: BASELINE_VERSION - 1 }), { ...FINGERPRINT });
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain(`version ${BASELINE_VERSION - 1}`);
		// The version is checked first: a stale file's other fields are not the
		// story, and listing them buries the one thing to do about it.
		const stale = baseline({ version: 1, fingerprint: { ...FINGERPRINT, host: "laptop" } });
		expect(refusals(stale, { ...FINGERPRINT })).toHaveLength(1);
	});

	it("refuses a median taken over too few runs, on either arm", () => {
		const thin = baseline({ fingerprint: { ...FINGERPRINT, runs: MIN_RUNS - 1 } });
		expect(refusals(thin, { ...FINGERPRINT }).join()).toContain(`${MIN_RUNS} required`);
		const thinCandidate = { ...FINGERPRINT, runs: MIN_RUNS - 1 };
		expect(refusals(baseline(), thinCandidate).join()).toContain(`${MIN_RUNS} required`);
		// The floor is a floor, not an equality: more runs than required is fine
		// on both sides.
		expect(refusals(baseline({ fingerprint: { ...FINGERPRINT, runs: 200 } }), { ...FINGERPRINT, runs: 40 })).toEqual(
			[],
		);
	});

	it("refuses when there is no baseline at all, and says how to make one", () => {
		const decision = decide(null, { ...FINGERPRINT }, 0.4);
		expect(decision.kind).toBe("refused");
		expect(decision.kind === "refused" && decision.reasons.join()).toContain("--update");
	});

	it("passes at the budget and fails past it", () => {
		const base = baseline({ median: 1 });
		// Exactly at the threshold is inside the budget; a hair past it is not.
		expect(decide(base, { ...FINGERPRINT }, THRESHOLD).kind).toBe("ok");
		expect(decide(base, { ...FINGERPRINT }, THRESHOLD + 1e-9).kind).toBe("regression");
		expect(decide(base, { ...FINGERPRINT }, 0.5)).toEqual({ kind: "ok", ratio: 0.5 });
	});

	it("refuses a baseline whose median is not a duration", () => {
		expect(decide(baseline({ median: 0 }), { ...FINGERPRINT }, 0.4).kind).toBe("refused");
		expect(decide(baseline({ median: -1 }), { ...FINGERPRINT }, 0.4).kind).toBe("refused");
	});

	it("reads the median and the run count out of a hyperfine export", () => {
		const raw = JSON.stringify({
			results: [{ mean: 0.5, median: 0.42, times: Array.from({ length: 23 }, () => 0.42) }],
		});
		expect(medianOf(raw)).toEqual({ median: 0.42, runs: 23 });
		// hyperfine 1.x omits `median` on a single-run export; the mean is then
		// the only number, and a run count it does not report is zero, which the
		// floor above rejects rather than treating as comparable.
		expect(medianOf(JSON.stringify({ results: [{ mean: 0.5 }] }))).toEqual({ median: 0.5, runs: 0 });
		expect(() => medianOf(JSON.stringify({ results: [] }))).toThrow("no result");
		expect(() => medianOf(JSON.stringify({ results: [{ times: [] }] }))).toThrow("no usable median");
	});
});
