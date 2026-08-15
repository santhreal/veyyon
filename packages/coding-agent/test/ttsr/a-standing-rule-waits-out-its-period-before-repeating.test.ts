/**
 * A `per-compact` rule may state how many transcript resets it waits out.
 *
 * WHY THIS SUITE EXISTS. `per-compact` meant "fires again after the very next
 * reset", and `resetForCompaction()` is reached from five places in the session:
 * compaction, a history rewrite, a rewind, a shake, and a restore. A rule whose
 * subject is a standing STATE rather than an event — `test-scope` sees a suite
 * command that is still a suite command — is true again the instant it is
 * re-armed, so it said the same thing over and over on a long session. That is
 * how a reminder becomes something
 * the reader learns to skip, which costs more than the reminder was ever worth.
 *
 * The class this closes: a rule's repeat PERIOD must be its own declaration and
 * must be honored by every path that re-arms it. The sweep below reads the
 * bundled rule set at run time and asserts the period each rule declares, so a
 * rule added later is covered, and a rule that quietly loses its period turns
 * this suite red rather than getting louder in production.
 *
 * What it does not catch: whether the five call sites should share one counter.
 * They do, deliberately — each takes the injected reminder out of the model's
 * view, which is the only property a rule deciding "have I been heard" can act
 * on — but that is a design decision, not something a test can settle.
 */
import { describe, expect, test } from "bun:test";
import type { Rule } from "../../src/capability/rule";
import { buildBuiltinRules } from "../../src/discovery/builtin-defaults";
import { TtsrManager } from "../../src/export/ttsr";
import { warmUpRule } from "../helpers/ttsr-warmup";

/** The periods bundled rules are expected to declare, by name. */
const DECLARED_PERIODS: Record<string, number> = {
	"test-scope": 3,
};

/** The working directory a `pathScope` rule in the sweep is compared against. */
const CWD = "/work/project";

function manager(): TtsrManager {
	return new TtsrManager(
		{
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		},
		{ getCwd: () => CWD },
	);
}

/** Every bundled rule that repeats per compaction, whichever section it ships in. */
function perCompactRules(): Rule[] {
	return buildBuiltinRules().filter(rule => rule.repeatMode === "per-compact");
}

/**
 * Whether the rule would fire again, driven through the real matcher.
 *
 * The buffer is reset first, as a new turn does: `checkDelta` APPENDS, so a
 * second identical probe would otherwise match against `bun testbun test` and
 * report a rule as suppressed when the matcher simply never saw the command.
 *
 * A rule carrying a warm-up is driven through it first, so this asks about the
 * repeat PERIOD and not about the warm-up — the two suppress a rule in ways that
 * look identical from here, and only one of them is this suite's subject. Warm-up
 * probes on a suppressed rule count for nothing, which is what keeps the negative
 * cases below honest.
 */
function armed(ttsr: TtsrManager, rule: Rule): boolean {
	const delta = SAMPLE_MATCH[rule.name] ?? "";
	const context = { source: "tool", toolName: TOOL[rule.name] ?? "bash" } as const;
	warmUpRule(ttsr, rule, delta, context);
	return ttsr.checkDelta(delta, context).some(fired => fired.name === rule.name);
}

/** A payload each bundled per-compact rule actually matches, so the check is the real one. */
const SAMPLE_MATCH: Record<string, string> = {
	"test-scope": "bun test",
	"irc-signal": '{"op":"send","to":"Main","message":"ack"}',
	"cwd-reroot": '{"path":"/work/other-project/crates/cli/src/main.rs"}',
};

const TOOL: Record<string, string> = {
	"test-scope": "bash",
	"irc-signal": "irc",
	"cwd-reroot": "read",
};

describe("a per-compact rule's period", () => {
	/**
	 * Every bundled per-compact rule must be exercisable here. A rule this sweep
	 * cannot make fire is a hole in the sweep, not a rule that passed.
	 */
	test("every bundled per-compact rule can be driven to fire", () => {
		const rules = perCompactRules();
		expect(rules.length).toBeGreaterThan(0);

		const unfirable = rules
			.filter(rule => {
				const ttsr = manager();
				return ttsr.addRule(rule) && !armed(ttsr, rule);
			})
			.map(rule => rule.name);

		expect(unfirable).toEqual([]);
	});

	/**
	 * The periods themselves, read off the shipped rules. A rule that declares one
	 * and a table that does not know about it are the same defect from two sides,
	 * so this is an exact comparison rather than a lookup with a default.
	 */
	test("the bundled rules declare exactly the periods recorded here", () => {
		const declared = Object.fromEntries(
			perCompactRules()
				.filter(rule => rule.repeatCompactions !== undefined)
				.map(rule => [rule.name, rule.repeatCompactions]),
		);

		expect(declared).toEqual(DECLARED_PERIODS);
	});

	/**
	 * The behavior the period buys, driven through the real manager: a rule with a
	 * period of three stays silent through two resets and speaks on the third.
	 */
	test.each(Object.entries(DECLARED_PERIODS))("%s waits out %d resets before repeating", (name, period) => {
		const rule = perCompactRules().find(candidate => candidate.name === name);
		expect(rule).toBeDefined();
		const ttsr = manager();
		expect(ttsr.addRule(rule as Rule)).toBe(true);

		expect(armed(ttsr, rule as Rule)).toBe(true);
		ttsr.markInjectedByNames([name]);
		expect(armed(ttsr, rule as Rule)).toBe(false);

		for (let reset = 1; reset < period; reset++) {
			ttsr.resetForCompaction();
			expect(armed(ttsr, rule as Rule)).toBe(false);
		}

		ttsr.resetForCompaction();
		expect(armed(ttsr, rule as Rule)).toBe(true);
	});

	/**
	 * And the period starts again from the repeat, rather than from the first
	 * injection: a rule that fired at reset three must not be re-armed at reset
	 * four because the arithmetic was done against a stale stamp.
	 */
	test("the period is counted from the last injection, not the first", () => {
		const rule = perCompactRules().find(candidate => candidate.name === "test-scope") as Rule;
		const ttsr = manager();
		ttsr.addRule(rule);

		ttsr.markInjectedByNames(["test-scope"]);
		for (let reset = 0; reset < 3; reset++) ttsr.resetForCompaction();
		expect(armed(ttsr, rule)).toBe(true);

		ttsr.markInjectedByNames(["test-scope"]);
		ttsr.resetForCompaction();
		expect(armed(ttsr, rule)).toBe(false);
		ttsr.resetForCompaction();
		ttsr.resetForCompaction();
		expect(armed(ttsr, rule)).toBe(true);
	});

	/**
	 * A rule that declares no period keeps the old meaning exactly: one reset and
	 * it may speak again. Changing that silently would make every other bundled
	 * per-compact rule quieter than its author wrote it.
	 */
	test("a rule with no declared period is re-armed by a single reset", () => {
		const rule = perCompactRules().find(candidate => candidate.repeatCompactions === undefined);
		expect(rule).toBeDefined();
		const ttsr = manager();
		ttsr.addRule(rule as Rule);

		ttsr.markInjectedByNames([(rule as Rule).name]);
		expect(armed(ttsr, rule as Rule)).toBe(false);
		ttsr.resetForCompaction();
		expect(armed(ttsr, rule as Rule)).toBe(true);
	});
});

describe("test-scope ships off", () => {
	/**
	 * It fires on every whole-suite command, which is a standing state on a
	 * session that is testing, so it ships opt-in rather than on. The mechanism is
	 * the experimental section: off until named in `ttsr.experimentalRules`.
	 */
	test("the bundled test-scope rule is experimental, so a default install never hears it", () => {
		const rule = buildBuiltinRules().find(candidate => candidate.name === "test-scope");

		expect(rule?.experimental).toBe(true);
		expect(rule?.section).toBe("experimental");
	});
});
