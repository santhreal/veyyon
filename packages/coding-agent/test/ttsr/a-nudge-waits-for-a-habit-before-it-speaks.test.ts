/**
 * A rule may require a HABIT before it says anything, and the unit of that habit is the
 * invocation.
 *
 * WHY THIS SUITE EXISTS. `cwd-reroot` fired on the first call that named a path outside the
 * working directory, which is one glance at one file — and the rule's own body then told
 * the reader to ignore it if the read was a one-off. Advice that arrives before the
 * behavior it is about exists is advice the reader learns to skip, and it arrived on a
 * channel shared with every other rule.
 *
 * The class this closes is not "cwd-reroot is too eager". It is: a rule that declares a
 * warm-up must be silent until it has matched in that many DISTINCT streams, must count a
 * stream once however many deltas that one call streams, and must start the count again
 * once it has been heard. The count-per-delta mistake is the dangerous one, because a
 * single tool call streams its arguments in a dozen pieces and every one of them re-matches
 * the same buffer: a warm-up of three clears inside one call and the rule fires exactly as
 * early as it did before, with a passing suite either way.
 *
 * The sweep reads the bundled rule set at run time, so a rule that adopts a warm-up later
 * is covered, and a rule that quietly loses one turns this red.
 *
 * What it does not catch: whether three is the right number for `cwd-reroot`. That is a
 * judgement about how much a reminder is worth, not a property a test can settle — the
 * suite pins that the declared number is honored, and `cwd-reroot-rule.test.ts` pins which
 * number ships.
 */
import { describe, expect, test } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { buildBuiltinRules } from "@veyyon/coding-agent/discovery/builtin-defaults";
import { buildRuleFromMarkdown } from "@veyyon/coding-agent/discovery/helpers";
import { TtsrManager, type TtsrMatchContext } from "@veyyon/coding-agent/export/ttsr";

const CWD = "/work/project";
/** A path outside CWD, deep enough for every navigation rule's condition. */
const OUTSIDE = '{"path":"/work/other-project/crates/cli/src/main.rs"}';

function manager(): TtsrManager {
	return new TtsrManager(
		{ enabled: true, contextMode: "discard", interruptMode: "never", repeatMode: "once", repeatGap: 10 },
		{ getCwd: () => CWD },
	);
}

/** The payload and tool each bundled warm-up rule actually matches on. */
const SAMPLE: Record<string, { delta: string; toolName: string }> = {
	"cwd-reroot": { delta: OUTSIDE, toolName: "read" },
};

/** Every bundled rule that declares a warm-up, whichever section it ships in. */
function warmupRules(): Rule[] {
	return buildBuiltinRules().filter(rule => (rule.warmupMatches ?? 1) > 1);
}

function sampleFor(rule: Rule): { delta: string; toolName: string } {
	const sample = SAMPLE[rule.name];
	if (!sample) {
		throw new Error(
			`bundled rule ${rule.name} declares warmupMatches but this sweep has no payload for it; ` +
				`add one to SAMPLE rather than letting the rule go unexercised`,
		);
	}
	return sample;
}

/** One invocation: a fresh stream key, matched once. */
function invoke(ttsr: TtsrManager, rule: Rule, streamKey: string, delta?: string): string[] {
	const sample = sampleFor(rule);
	ttsr.resetBuffer();
	return ttsr
		.checkDelta(delta ?? sample.delta, { source: "tool", toolName: sample.toolName, streamKey })
		.map(fired => fired.name);
}

/** A synthetic rule with an explicit warm-up, for the cases no bundled rule declares. */
function warmupRule(warmupMatches: number | undefined, overrides: Partial<Rule> = {}): Rule {
	return {
		name: "warmup-rule",
		path: "/rules/warmup-rule.md",
		content: "body",
		condition: ["NEEDLE"],
		scope: ["tool:read"],
		interruptMode: "never",
		warmupMatches,
		_source: { provider: "test", providerName: "test", path: "/rules/warmup-rule.md", level: "project" },
		...overrides,
	};
}

function managerWith(rule: Rule): TtsrManager {
	const ttsr = manager();
	expect(ttsr.addRule(rule)).toBe(true);
	return ttsr;
}

function probe(ttsr: TtsrManager, streamKey: string, delta = "NEEDLE"): string[] {
	ttsr.resetBuffer();
	return ttsr.checkDelta(delta, { source: "tool", toolName: "read", streamKey }).map(rule => rule.name);
}

describe("a bundled rule that declares a warm-up", () => {
	/**
	 * Every warm-up rule must be drivable here. A rule this sweep cannot make fire is a
	 * hole in the sweep, not a rule that passed — `sampleFor` throws by name rather than
	 * skipping, so adopting a warm-up without a payload turns this red.
	 */
	test("every bundled warm-up rule can be driven to fire", () => {
		const rules = warmupRules();
		expect(rules.length).toBeGreaterThan(0);

		const unfirable = rules
			.filter(rule => {
				const ttsr = managerWith(rule);
				const required = rule.warmupMatches ?? 1;
				let fired: string[] = [];
				for (let call = 0; call < required; call++) {
					fired = invoke(ttsr, rule, `toolcall:${call}`);
				}
				return !fired.includes(rule.name);
			})
			.map(rule => rule.name);

		expect(unfirable).toEqual([]);
	});

	/**
	 * The behavior the declaration buys, on the shipped rules: silent for every invocation
	 * below the count, and speaking on the one that reaches it. The expectation is derived
	 * from the rule's own number, so it cannot drift from what ships.
	 */
	test.each(warmupRules().map(rule => [rule.name, rule.warmupMatches ?? 1] as [string, number]))(
		"%s stays silent for the first %d-1 invocations",
		name => {
			const rule = warmupRules().find(candidate => candidate.name === name) as Rule;
			const required = rule.warmupMatches ?? 1;
			const ttsr = managerWith(rule);

			for (let call = 0; call < required - 1; call++) {
				expect(invoke(ttsr, rule, `toolcall:${call}`), `invocation ${call + 1}`).toEqual([]);
			}
			expect(invoke(ttsr, rule, `toolcall:${required - 1}`)).toEqual([name]);
		},
	);

	/**
	 * THE mistake this mechanism is easiest to write wrong. One tool call streams its
	 * arguments in many deltas and each one re-matches the whole buffer, so counting
	 * matches instead of streams clears a warm-up of three inside the first call — the rule
	 * fires on the first reach and every test above still passes.
	 */
	test.each(warmupRules().map(rule => rule.name))("%s is not warmed up by the deltas of one call", name => {
		const rule = warmupRules().find(candidate => candidate.name === name) as Rule;
		const sample = sampleFor(rule);
		const ttsr = managerWith(rule);
		const context: TtsrMatchContext = { source: "tool", toolName: sample.toolName, streamKey: "toolcall:single" };

		// The same call, streamed twenty times over. `checkDelta` appends, so this is exactly
		// what a live stream looks like: a growing buffer that keeps matching.
		for (let delta = 0; delta < 20; delta++) {
			expect(ttsr.checkDelta(sample.delta, context), `delta ${delta}`).toEqual([]);
		}
	});
});

describe("the warm-up mechanism", () => {
	/** A rule that declares nothing fires on its first match, exactly as it did before. */
	test("a rule with no warm-up fires on the first match", () => {
		expect(probe(managerWith(warmupRule(undefined)), "toolcall:0")).toEqual(["warmup-rule"]);
	});

	/** A declared warm-up of one is the same thing said out loud, and must not cost a match. */
	test("a warm-up of one fires on the first match", () => {
		expect(probe(managerWith(warmupRule(1)), "toolcall:0")).toEqual(["warmup-rule"]);
	});

	/** The count is over distinct streams, and a repeated stream key is one stream. */
	test("the same invocation counted twice does not advance the warm-up", () => {
		const ttsr = managerWith(warmupRule(3));

		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:1")).toEqual([]);
		expect(probe(ttsr, "toolcall:2")).toEqual(["warmup-rule"]);
	});

	/**
	 * A stream that does NOT match must not count. Otherwise the warm-up measures how much
	 * the model did rather than how often it did the thing the rule is about.
	 */
	test("a non-matching invocation does not advance the warm-up", () => {
		const ttsr = managerWith(warmupRule(2));

		expect(probe(ttsr, "toolcall:0", "nothing to see")).toEqual([]);
		expect(probe(ttsr, "toolcall:1", "still nothing")).toEqual([]);
		expect(probe(ttsr, "toolcall:2")).toEqual([]);
		expect(probe(ttsr, "toolcall:3")).toEqual(["warmup-rule"]);
	});

	/**
	 * Once cleared, the rule matches every later stream the way any other rule does: the
	 * repeat policy decides whether it speaks again, and the warm-up must not turn into a
	 * second, silent suppression on top of it.
	 */
	test("a cleared warm-up stays cleared until the rule is heard", () => {
		const ttsr = managerWith(warmupRule(2, { repeatMode: "after-gap", repeatGap: 0 }));

		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:1")).toEqual(["warmup-rule"]);
		expect(probe(ttsr, "toolcall:2")).toEqual(["warmup-rule"]);
		expect(probe(ttsr, "toolcall:3")).toEqual(["warmup-rule"]);
	});

	/**
	 * And the habit has to be established again once the reminder was delivered. Without
	 * this, a warm-up rule becomes a per-match rule the instant its repeat policy re-arms
	 * it, which is the noise the warm-up was added to remove.
	 */
	test("an injection restarts the warm-up", () => {
		const ttsr = managerWith(warmupRule(3, { repeatMode: "after-gap", repeatGap: 0 }));

		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:1")).toEqual([]);
		expect(probe(ttsr, "toolcall:2")).toEqual(["warmup-rule"]);

		ttsr.markInjectedByNames(["warmup-rule"]);

		expect(probe(ttsr, "toolcall:3")).toEqual([]);
		expect(probe(ttsr, "toolcall:4")).toEqual([]);
		expect(probe(ttsr, "toolcall:5")).toEqual(["warmup-rule"]);
	});

	/**
	 * A claim that was taken and then released never reached the model, so the pattern the
	 * rule already saw still stands. Making it start over would be the "it just does not
	 * fire" failure again, wearing a warm-up: an aborted turn would cost the reminder AND
	 * the evidence for it.
	 */
	test("a released claim leaves the warm-up cleared", () => {
		const ttsr = managerWith(warmupRule(2, { repeatMode: "after-gap", repeatGap: 0 }));

		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:1")).toEqual(["warmup-rule"]);
		ttsr.markInjectedByNames(["warmup-rule"]);
		ttsr.releaseInjectedByNames(["warmup-rule"]);

		expect(probe(ttsr, "toolcall:2")).toEqual(["warmup-rule"]);
	});

	/**
	 * Invocations that match while the rule is SUPPRESSED must not bank credit toward the
	 * next warm-up: the rule is not being ignored during that window, it has already been
	 * heard, and counting there would make the reminder come back on the first reach after
	 * every re-arming.
	 */
	test("invocations during suppression do not pre-pay the next warm-up", () => {
		const ttsr = managerWith(warmupRule(2, { repeatMode: "per-compact" }));

		expect(probe(ttsr, "toolcall:0")).toEqual([]);
		expect(probe(ttsr, "toolcall:1")).toEqual(["warmup-rule"]);
		ttsr.markInjectedByNames(["warmup-rule"]);
		for (let call = 2; call < 8; call++) expect(probe(ttsr, `toolcall:${call}`)).toEqual([]);

		ttsr.resetForCompaction();
		expect(probe(ttsr, "toolcall:8")).toEqual([]);
		expect(probe(ttsr, "toolcall:9")).toEqual(["warmup-rule"]);
	});

	/**
	 * Termination: a session reaches thousands of invocations, and a rule that has cleared
	 * its warm-up must keep answering on every one of them rather than going quiet or
	 * slowing down.
	 *
	 * The memory BOUND is not asserted here and cannot be from outside. Once the threshold
	 * is reached the ledger stops taking new keys, so it holds at most `warmupMatches` of
	 * them however long the session runs — but dropping that early-out changes no observable
	 * behavior, only how much the ledger keeps, so this test stays green against it. That is
	 * a mutation this suite knowingly does not catch.
	 */
	test("a long session keeps firing on every invocation", () => {
		const ttsr = managerWith(warmupRule(3, { repeatMode: "after-gap", repeatGap: 0 }));

		for (let call = 0; call < 2000; call++) {
			const fired = probe(ttsr, `toolcall:${call}`);
			expect(fired, `invocation ${call}`).toEqual(call < 2 ? [] : ["warmup-rule"]);
		}
	});
});

describe("parsing a warm-up out of rule frontmatter", () => {
	function parse(frontmatter: string): Rule {
		return buildRuleFromMarkdown("parsed-rule", `---\n${frontmatter}\n---\n\nbody\n`, "/rules/parsed-rule.md", {
			provider: "test",
			providerName: "test",
			path: "/rules/parsed-rule.md",
			level: "project",
		});
	}

	test("reads a whole positive count", () => {
		expect(parse('condition: "x"\nwarmupMatches: 3').warmupMatches).toBe(3);
	});

	test("leaves it undefined when the rule says nothing, so the rule fires on its first match", () => {
		expect(parse('condition: "x"').warmupMatches).toBeUndefined();
	});

	/**
	 * Zero and a negative are not smaller warm-ups and a fraction is not a count. Each is a
	 * typo, and coercing one would invent a policy the author did not write — the same
	 * reading `repeatGap` and `repeatCompactions` already take.
	 */
	test.each(["0", "-1", "1.5", '"3"', "true"])("ignores %s rather than coercing it", value => {
		expect(parse(`condition: "x"\nwarmupMatches: ${value}`).warmupMatches).toBeUndefined();
	});
});
