/**
 * `TtsrManager.addRule` refuses some rules, and every refusal has to be visible.
 *
 * WHY THIS SUITE EXISTS. A refused rule is not an error anywhere: the provider loaded it, `/rules`
 * lists it, its file is on disk, and it never matches. That state is indistinguishable from a rule
 * whose condition is simply never met, so a rule that CANNOT work looks exactly like a rule that had
 * nothing to say. `argot-load-nudge` shipped for months carrying no `condition` at all; had it been
 * registered it would have been dropped here in silence.
 *
 * `addRule` returning `false` is therefore a finding, not a fall-through, and each refusal must name
 * the rule in the log. The refusals are asserted through the return value plus the observable
 * consequence -- the rule is absent from `getRules()` and never matches -- because a rule that is
 * half-registered is the failure that would otherwise go unnoticed.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import type { TtsrSettings } from "@veyyon/coding-agent/config/settings";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { logger } from "@veyyon/utils";

function rule(overrides: Partial<Rule> = {}): Rule {
	return {
		name: "a-rule",
		path: "/rules/a-rule.md",
		content: "body",
		condition: ["needle"],
		scope: ["tool:read"],
		interruptMode: "never",
		_source: { provider: "test", providerName: "test", path: "/rules/a-rule.md", level: "project" },
		...overrides,
	};
}

function manager(overrides: Partial<TtsrSettings> = {}): TtsrManager {
	return new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
		...overrides,
	});
}

/**
 * Capture `logger.warn` calls so a refusal's LOUDNESS is asserted, not assumed.
 *
 * The whole point of these branches is that a rule which cannot work says so. A test that only checks
 * the return value would pass for a silent refusal, which is the defect.
 */
function captureWarnings(): {
	entries: Array<{ message: string; fields?: Record<string, unknown> }>;
	restore: () => void;
} {
	const entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
	const spy = vi.spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
		entries.push({ message, fields });
	}) as unknown as typeof logger.warn);
	return { entries, restore: () => spy.mockRestore() };
}

let warnings: ReturnType<typeof captureWarnings> | undefined;

afterEach(() => {
	warnings?.restore();
	warnings = undefined;
});

describe("a rule with no trigger at all", () => {
	/**
	 * THE regression. A rule file with `scope` and no `condition` reads as complete, and TTSR has no
	 * way to know when to fire it. It is refused, and the refusal is logged at warn naming the rule and
	 * its path, so the operator sees a rule file to fix rather than a rule that never speaks.
	 */
	it("is refused rather than registered and never monitored, and says which rule file to fix", () => {
		warnings = captureWarnings();
		const m = manager();

		expect(m.addRule(rule({ condition: undefined, astCondition: undefined }))).toBe(false);

		expect(m.getRules()).toEqual([]);
		expect(m.hasRules()).toBe(false);
		expect(warnings.entries).toEqual([
			{
				message: "TTSR rule has no condition or astCondition, never monitored",
				fields: { ruleName: "a-rule", path: "/rules/a-rule.md" },
			},
		]);
	});

	it("is refused when its condition list is present but empty", () => {
		expect(manager().addRule(rule({ condition: [] }))).toBe(false);
	});

	/**
	 * A blank condition used to compile to `new RegExp("")`, which matches EVERY delta. So the quietest
	 * mistake in a rule file -- `condition: ""` -- produced the loudest possible rule, firing on every
	 * stream instead of never. Blank patterns are skipped now, which leaves this rule with no trigger
	 * and lands it on the refusal above.
	 */
	it("is refused when every condition is blank, rather than becoming a catch-all", () => {
		warnings = captureWarnings();
		const m = manager();

		expect(m.addRule(rule({ condition: ["", "   ", "\t"] }))).toBe(false);

		expect(m.getRules()).toEqual([]);
		// One warning per blank pattern, then the refusal: three blanks and the no-trigger report.
		expect(warnings.entries.map(entry => entry.message)).toEqual([
			"TTSR condition is blank, skipping condition",
			"TTSR condition is blank, skipping condition",
			"TTSR condition is blank, skipping condition",
			"TTSR rule has no condition or astCondition, never monitored",
		]);
	});

	/** A blank pattern beside a real one drops only the blank; the rule still registers and matches. */
	it("drops a blank condition and keeps the real one beside it", () => {
		const m = manager();

		expect(m.addRule(rule({ condition: ["", "needle"] }))).toBe(true);

		expect(m.checkDelta("no match here", { source: "tool", toolName: "read" })).toEqual([]);
		m.resetBuffer();
		expect(m.checkDelta("a needle here", { source: "tool", toolName: "read" }).map(r => r.name)).toEqual(["a-rule"]);
	});

	it("is accepted on an astCondition alone, because that is a real trigger", () => {
		const m = manager();

		expect(m.addRule(rule({ condition: undefined, astCondition: ["console.log($$$)"], scope: ["tool:edit"] }))).toBe(
			true,
		);

		expect(m.getRules().map(r => r.name)).toEqual(["a-rule"]);
	});
});

describe("the other refusals", () => {
	it("refuses a second rule with a name already registered, keeping the first", () => {
		const m = manager();
		expect(m.addRule(rule({ content: "first" }))).toBe(true);

		expect(m.addRule(rule({ content: "second" }))).toBe(false);

		expect(m.getRules().map(r => r.content)).toEqual(["first"]);
	});

	it("refuses every rule while TTSR is disabled, so nothing is half-registered", () => {
		const m = manager({ enabled: false });

		expect(m.addRule(rule())).toBe(false);

		expect(m.getRules()).toEqual([]);
	});

	it("refuses a rule whose scope names no stream it could match on", () => {
		// Every token here is unparseable, which leaves a scope allowing nothing. Already logged at warn
		// before this suite existed; asserted here so the refusals live in one place and a future fourth
		// is added beside them.
		expect(manager().addRule(rule({ scope: ["tool:", "@@@"] }))).toBe(false);
	});

	/**
	 * A bare token is read as a TOOL NAME, so a scope naming a tool that does not exist parses fine and
	 * registers a rule that can never match. `TtsrManager` does not know the tool registry, so it cannot
	 * tell this from a rule scoped to a tool an extension will register later; pinned here so the
	 * behaviour is deliberate rather than discovered.
	 */
	it("accepts a scope naming a tool that does not exist, which is why the name has to be right", () => {
		const m = manager();

		expect(m.addRule(rule({ scope: ["nonsense"] }))).toBe(true);

		expect(m.checkDelta("a needle here", { source: "tool", toolName: "read" })).toEqual([]);
	});
});

describe("a scope naming a tool that does not exist", () => {
	/**
	 * The report `addRule` cannot make. A `TtsrManager` has no tool registry, so the check runs later,
	 * from `sdk.ts`, once the registry is complete including MCP and extension tools. Until then the rule
	 * is registered and silently unable to match, which is the same invisible failure as a rule with no
	 * condition.
	 */
	it("is reported by name, with the closest registered tool, and the rule survives", () => {
		warnings = captureWarnings();
		const m = manager();
		expect(m.addRule(rule({ scope: ["raed"] }))).toBe(true);

		m.reportUnknownToolScopes(["read", "edit", "bash"]);

		expect(warnings.entries).toEqual([
			{
				message: "TTSR rule is scoped to a tool that does not exist, so it can never match",
				fields: { ruleName: "a-rule", toolName: "raed", rulePath: "/rules/a-rule.md", closest: "read" },
			},
		]);
		// Reported, not removed: a rule scoped to a tool an extension registers later must survive.
		expect(m.getRules().map(r => r.name)).toEqual(["a-rule"]);
	});

	it("names a transposed tool, which is what a typo usually is", () => {
		// `raed` for `read` is one transposition. Plain edit distance charges it two and would reject the
		// suggestion, which is why the check counts a swap as one edit.
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["web_saerch"] }));

		m.reportUnknownToolScopes(["read", "web_search"]);

		expect(warnings.entries[0]?.fields?.closest).toBe("web_search");
	});

	it("offers no guess when nothing registered is close, because a wrong guess is worse than none", () => {
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["quux"] }));

		m.reportUnknownToolScopes(["read", "edit"]);

		expect(warnings.entries[0]?.fields?.closest).toBeUndefined();
	});

	it("reports nothing when every scoped tool is registered", () => {
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["tool:read", "tool:edit"] }));

		m.reportUnknownToolScopes(["read", "edit"]);

		expect(warnings.entries).toEqual([]);
	});

	it("is case-insensitive and trims, matching how a scope token is parsed", () => {
		// `#parseToolScopeToken` lowercases and trims, so the check has to compare the same way or every
		// rule using `tool:Read` would be reported as a typo.
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["tool:Read"] }));

		m.reportUnknownToolScopes([" READ "]);

		expect(warnings.entries).toEqual([]);
	});

	/**
	 * An empty registry means the caller does not know the tools yet, which is not evidence that a rule is
	 * wrong. Reporting every rule in that state would train the reader to ignore the warning.
	 */
	it("reports nothing when the caller has no tool list to check against", () => {
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["raed"] }));

		m.reportUnknownToolScopes([]);

		expect(warnings.entries).toEqual([]);
		expect(m.getRules()).toHaveLength(1);
	});

	it("says nothing about a rule scoped only to text or thinking, which name no tool", () => {
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["text", "thinking"] }));

		m.reportUnknownToolScopes(["read"]);

		expect(warnings.entries).toEqual([]);
	});

	it("reports a catch-all tool scope as fine, since `tool` names no specific tool", () => {
		warnings = captureWarnings();
		const m = manager();
		m.addRule(rule({ scope: ["tool"] }));

		m.reportUnknownToolScopes(["read"]);

		expect(warnings.entries).toEqual([]);
	});
});

describe("a rule that is accepted", () => {
	/** The premise for every refusal above: this shape does register and does match. */
	it("registers and matches its condition", () => {
		const m = manager();
		expect(m.addRule(rule())).toBe(true);

		expect(m.checkDelta("a needle here", { source: "tool", toolName: "read" }).map(r => r.name)).toEqual(["a-rule"]);
	});
});
