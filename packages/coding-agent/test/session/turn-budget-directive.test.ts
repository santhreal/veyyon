/**
 * The `+Nk` turn token-budget directive: what arms it, and what must never arm it.
 *
 * WHY THIS EXISTS. The directive shipped with the regex `/(?:^|\s)\+(\d+...)([km])?(!)?/`,
 * where the unit was OPTIONAL. `+` immediately followed by digits is common in ordinary
 * prose, so a plain sentence silently set a per-turn output ceiling of a few dozen tokens.
 * That is not a small budget, it is an exhausted one: `budget.remaining()` reads as spent
 * and, under the hard `!` form, eval `agent()` refuses to spawn at all. A user hit this
 * live and described the budget as "randomly toggling on", because nothing in the message
 * looked like a directive.
 *
 * Two defenses, both locked here. The unit is now mandatory, which kills the whole class
 * of prose false positive; and the directive is opt-in behind `magicKeywords.turnBudget`,
 * default off, so an unarmed session treats `+500k` as text.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { parseTurnBudget, parseTurnBudgetDirective } from "@veyyon/coding-agent/session/turn-budget";

describe("parseTurnBudget: prose that must never arm a budget", () => {
	/** Locks out: a pasted diff stat armed a 42-token ceiling. */
	it("ignores a diff stat", () => {
		expect(parseTurnBudget("the diff is +42 -13 lines")).toBeNull();
	});

	/** Locks out: agreeing with "+1" armed a 1-token ceiling, the tightest possible. */
	it("ignores a plus-one agreement", () => {
		expect(parseTurnBudget("+1 to that idea")).toBeNull();
	});

	/** Locks out: a count of things to change armed a 2-token ceiling. */
	it("ignores a count of workers", () => {
		expect(parseTurnBudget("bump it to +2 workers and retry")).toBeNull();
	});

	/** Locks out: a reported delta armed a 5-token ceiling. */
	it("ignores a score delta", () => {
		expect(parseTurnBudget("score went +5 today")).toBeNull();
	});

	/** Locks out: a fractional percentage rounded up to a 1-token ceiling. */
	it("ignores a fractional percentage", () => {
		expect(parseTurnBudget("cost was +0.5 percent")).toBeNull();
	});

	/** Locks out: a relative commit reference armed a 3-token ceiling. */
	it("ignores a relative commit reference", () => {
		expect(parseTurnBudget("see commit +3 above")).toBeNull();
	});

	/** Locks out: the unit-less form entirely. Only `k` and `m` are directives now. */
	it("ignores a bare number even when it is plausibly a token count", () => {
		expect(parseTurnBudget("+500")).toBeNull();
		expect(parseTurnBudget("give me +500 tokens")).toBeNull();
		expect(parseTurnBudget("+500!")).toBeNull();
	});
});

describe("parseTurnBudget: the real directive still works", () => {
	/** Locks out: over-tightening the regex and breaking the one form users actually type. */
	it("reads thousands from k and defaults to advisory", () => {
		expect(parseTurnBudget("use +500k for this turn")).toEqual({ total: 500_000, hard: false });
	});

	/** Locks out: dropping the millions multiplier while fixing the unit-less case. */
	it("reads millions from m", () => {
		expect(parseTurnBudget("+2m")).toEqual({ total: 2_000_000, hard: false });
	});

	/** Locks out: losing the `!` hard marker, which is what makes agent() refuse to spawn. */
	it("marks the bang form hard", () => {
		expect(parseTurnBudget("+500k!")).toEqual({ total: 500_000, hard: true });
	});

	/** Locks out: a fractional value silently truncating instead of scaling by the unit. */
	it("scales fractional values by the unit", () => {
		expect(parseTurnBudget("+0.5k")).toEqual({ total: 500, hard: false });
		expect(parseTurnBudget("+1.5m!")).toEqual({ total: 1_500_000, hard: true });
	});

	/** Locks out: case sensitivity making `+500K` a silent no-op. */
	it("accepts an uppercase unit", () => {
		expect(parseTurnBudget("+500K")).toEqual({ total: 500_000, hard: false });
	});
});

describe("parseTurnBudget: token boundaries", () => {
	/** Locks out: requiring leading whitespace, which would break a message that opens with the directive. */
	it("matches at the start of the message", () => {
		expect(parseTurnBudget("+500k do the thing")).toEqual({ total: 500_000, hard: false });
	});

	/** Locks out: requiring trailing whitespace, which would break a message that ends with the directive. */
	it("matches at the end of the message", () => {
		expect(parseTurnBudget("do the thing +500k")).toEqual({ total: 500_000, hard: false });
	});

	/** Locks out: newlines not counting as boundaries, so a directive on its own line went unread. */
	it("matches on a line of its own", () => {
		expect(parseTurnBudget("do the thing\n+2m!\nthen stop")).toEqual({ total: 2_000_000, hard: true });
	});

	/** Locks out: matching mid-word, e.g. an identifier or a filename that happens to contain the pattern. */
	it("does not match inside a word", () => {
		expect(parseTurnBudget("batch+500k")).toBeNull();
		expect(parseTurnBudget("+500kb of payload")).toBeNull();
	});

	/** Locks out: firing inside a URL, where `+` separates path or query segments. */
	it("does not match inside a URL", () => {
		expect(parseTurnBudget("see https://example.dev/v2+500k/report for numbers")).toBeNull();
		expect(parseTurnBudget("open https://example.dev/+500k")).toBeNull();
	});

	/** Locks out: firing on semver build metadata, which is written exactly as `+<token>`. */
	it("does not match a version build tag", () => {
		expect(parseTurnBudget("shipped 1.2.3+500k yesterday")).toBeNull();
	});

	/** Locks out: a zero or negative-looking value producing a permanently exhausted ceiling. */
	it("rejects a zero budget", () => {
		expect(parseTurnBudget("+0k")).toBeNull();
	});
});

describe("parseTurnBudgetDirective: the opt-in gate", () => {
	/** Locks out: shipping the directive armed, which is how the live incident happened. */
	it("is off by default on a real Settings instance", () => {
		const settings = Settings.isolated({});
		expect(settings.get("magicKeywords.turnBudget")).toBe(false);
		expect(parseTurnBudgetDirective(settings, "use +500k for this turn")).toBeNull();
		expect(parseTurnBudgetDirective(settings, "+2m!")).toBeNull();
	});

	/** Locks out: the setting being wired to nothing, so turning it on changes nothing. */
	it("parses once the operator turns it on", () => {
		const settings = Settings.isolated({ "magicKeywords.turnBudget": true });
		expect(parseTurnBudgetDirective(settings, "use +500k for this turn")).toEqual({
			total: 500_000,
			hard: false,
		});
		expect(parseTurnBudgetDirective(settings, "+2m!")).toEqual({ total: 2_000_000, hard: true });
	});

	/** Locks out: the directive escaping the master Magic Keywords switch its group lives under. */
	it("stays off when the master magic-keywords switch is off", () => {
		const settings = Settings.isolated({ "magicKeywords.enabled": false, "magicKeywords.turnBudget": true });
		expect(parseTurnBudgetDirective(settings, "use +500k for this turn")).toBeNull();
	});

	/** Locks out: an armed session regressing on the prose cases the parser now rejects. */
	it("still ignores prose when armed", () => {
		const settings = Settings.isolated({ "magicKeywords.turnBudget": true });
		expect(parseTurnBudgetDirective(settings, "the diff is +42 -13 lines")).toBeNull();
		expect(parseTurnBudgetDirective(settings, "+1 to that idea")).toBeNull();
	});
});
