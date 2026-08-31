/**
 * WHY: an autoresearch segment may now hold several candidate implementations
 * instead of one, and a candidate is a diff written by an agent that is being
 * scored on a number. This suite defends the rules that decide which candidates
 * reach measurement, who reviews them, and which one is kept.
 *
 * The defect class it closes is a candidate that improves the metric without
 * genuinely improving the code: an unreadable artifact, an edit outside the
 * declared scope, a duplicate presented as independent evidence, or work moved
 * out of the timed region. Each rule here was written against a failure
 * observed in a live run, not imagined.
 *
 * What it does not catch: whether a certifier's judgement is correct. A
 * reviewer that approves a genuinely gamed diff is outside these rules, which
 * is exactly why legibility and scope are enforced mechanically before any
 * reviewer is asked.
 */
import { describe, expect, test } from "bun:test";
import {
	type Candidate,
	certificationDegraded,
	certificationPairs,
	certifierFor,
	improves,
	opaquePayload,
	rank,
	relocatedCost,
	scopeDeviations,
	selectWinner,
	triage,
	type Verdict,
} from "../../src/autoresearch/swarm";

function candidate(arm: string, diff: string, modifiedPaths: string[] = ["solution.py"]): Candidate {
	return { arm, hypothesis: `hypothesis ${arm}`, diff, modifiedPaths };
}

const NORMAL_DIFF = "--- a/solution.py\n+++ b/solution.py\n+def f():\n+    return 1\n";

describe("diff legibility", () => {
	test("rejects a base64 payload of the size a compiled artifact needs", () => {
		// Reproduces the live failure: a 22,864-byte ELF embedded in a 26-line
		// file read as a 3000x win, was certified clean, and was wrong on every
		// non-ASCII input.
		const blob = "QUJDRA".repeat(400);
		expect(opaquePayload(`+_SO_B64 = '${blob}'\n`)).toBe("2400-char opaque literal");
	});

	test("rejects a git binary patch", () => {
		expect(opaquePayload("GIT binary patch\ndelta 42\n")).toBe("git binary patch");
	});

	test("ignores a long opaque run that is being removed, not added", () => {
		expect(opaquePayload(`-_SO_B64 = '${"QUJDRA".repeat(400)}'\n`)).toBeNull();
	});

	test("accepts ordinary source, including a long inline table", () => {
		const table = `+PEQ = [${Array.from({ length: 300 }, (_, i) => i).join(", ")}]`;
		expect(opaquePayload(table)).toBeNull();
		expect(opaquePayload(NORMAL_DIFF)).toBeNull();
	});

	test("accepts a long but structured literal that is not one opaque run", () => {
		// Separators break the run, which is what distinguishes data a human
		// wrote from an encoded artifact.
		const structured = `+KEYS = "${Array.from({ length: 200 }, () => "abcdef").join("-")}"`;
		expect(structured.length).toBeGreaterThan(1000);
		expect(opaquePayload(structured)).toBeNull();
	});
});

describe("scope", () => {
	test("reports only paths the session declared off limits, sorted", () => {
		expect(scopeDeviations(["harness.py", "solution.py", "bench.sh"], ["bench.sh", "harness.py"])).toEqual([
			"bench.sh",
			"harness.py",
		]);
	});

	test("permits everything when the session declares no off-limits paths", () => {
		expect(scopeDeviations(["harness.py"], [])).toEqual([]);
	});
});

describe("triage", () => {
	test("keeps a clean candidate and names why each other was dropped", () => {
		const result = triage(
			[
				candidate("a0", NORMAL_DIFF),
				candidate("a1", "   "),
				candidate("a2", NORMAL_DIFF, ["harness.py"]),
				candidate("a3", `+B = '${"QUJDRA".repeat(400)}'`),
				candidate("a4", NORMAL_DIFF),
			],
			["harness.py"],
		);
		expect(result.survivors.map(entry => entry.arm)).toEqual(["a0"]);
		expect(result.rejected).toEqual([
			{ arm: "a1", reason: "empty", detail: "no change" },
			{ arm: "a2", reason: "scope", detail: "harness.py" },
			{ arm: "a3", reason: "opaque", detail: "2400-char opaque literal" },
			{ arm: "a4", reason: "duplicate", detail: "identical to a0" },
		]);
	});

	test("reports an out-of-scope edit as scope even when the diff is also unreadable", () => {
		const result = triage([candidate("a0", `+B = '${"QUJDRA".repeat(400)}'`, ["harness.py"])], ["harness.py"]);
		expect(result.rejected[0].reason).toBe("scope");
	});

	test("two arms that independently reach the same diff count once", () => {
		const result = triage([candidate("a0", NORMAL_DIFF), candidate("a1", NORMAL_DIFF)], []);
		expect(result.survivors).toHaveLength(1);
		expect(result.rejected[0]).toMatchObject({ arm: "a1", reason: "duplicate" });
	});
});

describe("certifier topology", () => {
	test("is chosen by surviving arms, and a ring needs three", () => {
		expect(certifierFor(0)).toBe("void");
		expect(certifierFor(1)).toBe("director");
		// Two arms would have to review each other, which is the reciprocal pair
		// a ring exists to avoid.
		expect(certifierFor(2)).toBe("director");
		expect(certifierFor(3)).toBe("ring");
		expect(certifierFor(9)).toBe("ring");
	});

	test("a ring reviews every arm once, by an author who did not write it", () => {
		const arms = [candidate("a0", "x"), candidate("a1", "y"), candidate("a2", "z")];
		const pairs = certificationPairs(arms);
		expect(pairs).toEqual([
			{ reviewer: "a0", target: "a1" },
			{ reviewer: "a1", target: "a2" },
			{ reviewer: "a2", target: "a0" },
		]);
		expect(new Set(pairs.map(pair => pair.target)).size).toBe(3);
		for (const pair of pairs) expect(pair.reviewer).not.toBe(pair.target);
	});

	test("no ring pair reviews each other", () => {
		const arms = ["a0", "a1", "a2", "a3", "a4"].map(arm => candidate(arm, arm));
		const pairs = certificationPairs(arms);
		const edges = new Set(pairs.map(pair => `${pair.reviewer}>${pair.target}`));
		for (const pair of pairs) expect(edges.has(`${pair.target}>${pair.reviewer}`)).toBe(false);
	});

	test("the director reviews every arm when there are too few for a ring", () => {
		expect(certificationPairs([candidate("a0", "x"), candidate("a1", "y")])).toEqual([
			{ reviewer: "director", target: "a0" },
			{ reviewer: "director", target: "a1" },
		]);
	});

	test("degradation is reported when arms dead-end below the configured breadth", () => {
		// The live failure mode: breadth 5, three arms give up, and the segment
		// silently reviews through the director.
		expect(certificationDegraded(5, 2)).toBe(true);
		expect(certificationDegraded(5, 3)).toBe(false);
		// A serial session is not degraded; it never configured a ring.
		expect(certificationDegraded(1, 1)).toBe(false);
	});
});

describe("winner selection", () => {
	const verdicts = new Map<string, Verdict>();

	test("ranks by the session's metric direction", () => {
		const measured = [
			{ arm: "a0", metric: 10 },
			{ arm: "a1", metric: 3 },
			{ arm: "a2", metric: 7 },
		];
		expect(rank(measured, "lower").map(entry => entry.arm)).toEqual(["a1", "a2", "a0"]);
		expect(rank(measured, "higher").map(entry => entry.arm)).toEqual(["a0", "a2", "a1"]);
	});

	test("does not mutate the caller's array", () => {
		const measured = [
			{ arm: "a0", metric: 10 },
			{ arm: "a1", metric: 3 },
		];
		rank(measured, "lower");
		expect(measured.map(entry => entry.arm)).toEqual(["a0", "a1"]);
	});

	test("improvement respects direction", () => {
		expect(improves(3, 10, "lower")).toBe(true);
		expect(improves(10, 3, "lower")).toBe(false);
		expect(improves(10, 3, "higher")).toBe(true);
		// Equal is not an improvement in either direction.
		expect(improves(5, 5, "lower")).toBe(false);
		expect(improves(5, 5, "higher")).toBe(false);
	});

	test("keeps the best candidate that beats the baseline", () => {
		const winner = selectWinner(
			[
				{ arm: "a0", metric: 9 },
				{ arm: "a1", metric: 4 },
			],
			10,
			"lower",
			verdicts,
		);
		expect(winner?.arm).toBe("a1");
	});

	test("skips a flagged arm however good its number is", () => {
		// The whole point of certification: a faster number obtained by gaming
		// the benchmark is not a result.
		const flagged = new Map<string, Verdict>([
			["a1", { arm: "a1", certifiedBy: "a0", flagged: true, reason: "HACK caches by input identity" }],
		]);
		const winner = selectWinner(
			[
				{ arm: "a0", metric: 9 },
				{ arm: "a1", metric: 0.1 },
			],
			10,
			"lower",
			flagged,
		);
		expect(winner?.arm).toBe("a0");
	});

	test("returns null when nothing beats the baseline", () => {
		expect(selectWinner([{ arm: "a0", metric: 11 }], 10, "lower", verdicts)).toBeNull();
	});

	test("returns null when every improvement was flagged", () => {
		const flagged = new Map<string, Verdict>([
			["a0", { arm: "a0", certifiedBy: "director", flagged: true, reason: "HACK hardcodes answers" }],
		]);
		expect(selectWinner([{ arm: "a0", metric: 1 }], 10, "lower", flagged)).toBeNull();
	});

	test("an unflagged verdict does not disqualify", () => {
		const clean = new Map<string, Verdict>([["a0", { arm: "a0", certifiedBy: "a1", flagged: false, reason: null }]]);
		expect(selectWinner([{ arm: "a0", metric: 1 }], 10, "lower", clean)?.arm).toBe("a0");
	});
});

describe("cost relocation", () => {
	test("reports growth in the cost a fresh checkout pays", () => {
		// The live case: 0.10 ms reported against 512 ms of compilation the
		// timed region never saw.
		expect(relocatedCost({ ms: 0.1, cold_ms: 512.25 }, { ms: 192.78, cold_ms: 1.65 })).toBeCloseTo(510.6, 1);
	});

	test("is zero for a benchmark that reports no cold metric", () => {
		expect(relocatedCost({ ms: 1 }, { ms: 2 })).toBe(0);
		expect(relocatedCost({ ms: 1, cold_ms: 5 }, { ms: 2 })).toBe(0);
	});

	test("is negative, not flagged, when a candidate lowers startup cost", () => {
		expect(relocatedCost({ cold_ms: 2 }, { cold_ms: 10 })).toBe(-8);
	});
});
