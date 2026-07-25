/**
 * A TTSR nudge that matches has to actually reach the model, and has to be able to match again.
 *
 * WHY THIS SUITE EXISTS. `cwd-reroot` was reported as "it just does not work" — not firing wrongly,
 * not firing at all, most of the time. Three separate defects on the tool-scoped delivery path each
 * produced that symptom, and none of them was visible from outside: a suppressed rule looks exactly
 * like a rule whose condition did not match.
 *
 * A. THE BODY WAS NEVER RENDERED. There are two delivery paths. A stream-interrupting rule went
 *    through `#getTtsrInjectionContent`, which resolves the body's template. A tool-scoped rule
 *    (`interruptMode: never`, matching on a tool argument stream) had its RAW body folded into the
 *    tool result. `cwd-reroot` only ever takes the second path, so what reached the model was
 *    `{{#if matchedPath}}…{{/if}}` markup: it named neither directory and advised calling a tool
 *    that is not registered by default. The nudge arrived and said nothing usable.
 *
 * B. THE CLAIM WAS TAKEN BEFORE DELIVERY AND NEVER GIVEN BACK. A tool-scoped rule is claimed the
 *    moment it is bucketed, so a sibling tool call in the same assistant message cannot re-match it.
 *    Delivery happens later, in `afterToolCall`. A turn that aborts or errors never gets there, and
 *    the bucket was cleared without releasing the claim — so under the default `repeatMode: "once"`
 *    one interrupted turn retired the rule for the whole session, and the retirement was persisted
 *    across resume.
 *
 * C. `repeatMode: "once"` IS THE WRONG DEFAULT FOR NAVIGATIONAL ADVICE. Firing once per session is
 *    right for a rule stating a convention and wrong for one whose advice applies again to a
 *    different directory. Under the global default, `cwd-reroot` fired for the first foreign project
 *    a session touched and stayed silent for every later one.
 *
 * Each defect gets its own block below. The claim-release and repeat-policy contracts are asserted
 * against `TtsrManager` directly, which is where the state lives. Defect A's two delivery paths are
 * private to `AgentSession`, so it is covered two ways: the render is exercised through the same
 * context the session builds, and a source lock pins that neither path can go back to passing a raw
 * body — a leak that a behavioural test cannot see, because raw markup is still a non-empty string.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getCapability } from "@veyyon/coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@veyyon/coding-agent/capability/rule";
import type { LoadContext } from "@veyyon/coding-agent/capability/types";
import type { TtsrSettings } from "@veyyon/coding-agent/config/settings";
import { buildRuleFromMarkdown } from "@veyyon/coding-agent/discovery/helpers";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { prompt } from "@veyyon/utils";
import "@veyyon/coding-agent/discovery";

const CWD = "/work/project";
const OUTSIDE = '{"path":"/work/other-project/crates/cli/src/main.rs"}';
const TOOL = { source: "tool", toolName: "read" } as const;

const AGENT_SESSION = path.join(import.meta.dir, "../../src/session/agent-session.ts");

async function loadBuiltinRules(): Promise<Rule[]> {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

async function builtinRule(name: string): Promise<Rule> {
	const rule = (await loadBuiltinRules()).find(r => r.name === name);
	if (!rule) throw new Error(`bundled rule ${name} missing`);
	return rule;
}

/** A rule matching any absolute path of four or more segments, scoped to paths outside the cwd. */
function pathRule(overrides: Partial<Rule> = {}): Rule {
	return {
		name: "path-rule",
		path: "/rules/path-rule.md",
		content: "body",
		condition: ["(?:^|[\\s\"'=(,])/(?:[\\w.@+-]+/){3,}[\\w.@+-]+"],
		scope: ["tool:read"],
		interruptMode: "never",
		pathScope: "outside-cwd",
		_source: { provider: "test", providerName: "test", path: "/rules/path-rule.md", level: "project" },
		...overrides,
	};
}

function settings(overrides: Partial<TtsrSettings> = {}): TtsrSettings {
	return {
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
		...overrides,
	};
}

/** A manager holding one rule, with the working directory the path scope compares against. */
function managerWith(rule: Rule, overrides: Partial<TtsrSettings> = {}): TtsrManager {
	const manager = new TtsrManager(settings(overrides), { getCwd: () => CWD });
	expect(manager.addRule(rule)).toBe(true);
	return manager;
}

function matchNames(manager: TtsrManager, delta = OUTSIDE): string[] {
	manager.resetBuffer();
	return manager.checkDelta(delta, TOOL).map(r => r.name);
}

describe("A: the body a tool-scoped rule delivers", () => {
	/**
	 * The tool-scoped path used to fold the raw body in, so this asserts the resolved text of the one
	 * rule that only ever takes that path. Unresolved markup is what the model actually saw.
	 */
	it("carries no unresolved template markup once rendered with the session's context", async () => {
		const rule = await builtinRule("cwd-reroot");

		const rendered = prompt.render(rule.content, {
			argot: false,
			cwd: CWD,
			matchedPath: "/work/other-project/crates/cli/src/main.rs",
		});

		expect(rendered).not.toContain("{{");
		expect(rendered).not.toContain("}}");
		expect(rendered).toContain("/work/other-project/crates/cli/src/main.rs");
		expect(rendered).toContain(CWD);
	});

	/**
	 * The raw body is not merely unresolved, it is WRONG: it advises `argot_load`, a tool that is not
	 * registered unless `argot.enabled` is on. Delivering the raw body therefore delivered dead advice
	 * to every default install, which is the difference between "unrendered" and "harmless".
	 */
	it("drops the argot advice the raw body carries when argot is off", async () => {
		const rule = await builtinRule("cwd-reroot");

		expect(rule.content).toContain("argot_load");
		expect(prompt.render(rule.content, { argot: false, cwd: CWD, matchedPath: undefined })).not.toContain("argot");
		expect(prompt.render(rule.content, { argot: true, cwd: CWD, matchedPath: undefined })).toContain("argot_load");
	});

	/**
	 * Source lock for both delivery paths, because the leak is invisible to a behavioural assertion:
	 * a raw body is a non-empty string that renders as prose with two lines of markup in it. Passing
	 * `content: r.content` is exactly the defect; both call sites must go through the one renderer.
	 */
	it("is rendered by one owner on both delivery paths", () => {
		const source = fs.readFileSync(AGENT_SESSION, "utf8");

		expect(source).not.toContain("content: r.content");
		expect(source.match(/content: this\.#renderRuleBody\(r\)/g)?.length).toBe(2);
		// And that owner resolves all three variables a bundled rule body may reference.
		const renderer = source.slice(source.indexOf("#renderRuleBody(rule: Rule): string {"));
		const body = renderer.slice(0, renderer.indexOf("\n\t}"));
		expect(body).toContain("argot:");
		expect(body).toContain("cwd:");
		expect(body).toContain("matchedPath:");
	});
});

describe("B: a claim taken but never delivered", () => {
	/** The premise: a claim does suppress the next match, which is why releasing it matters. */
	it("suppresses the rule while it is held", () => {
		const manager = managerWith(pathRule());

		expect(matchNames(manager)).toEqual(["path-rule"]);
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual([]);
	});

	/**
	 * THE regression. An aborted turn drops the bucket, so the claim has to come back or the rule is
	 * retired for the session having shown the model nothing.
	 */
	it("lets the rule match again after the claim is released", () => {
		const manager = managerWith(pathRule());
		manager.markInjectedByNames(["path-rule"]);
		expect(matchNames(manager)).toEqual([]);

		manager.releaseInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual(["path-rule"]);
	});

	/**
	 * Release also has to erase the record that is PERSISTED, not only the in-memory suppression.
	 * `getInjectedRuleNames` is what the session writes to disk; a released claim left in there comes
	 * back on resume and suppresses the rule in the next session too.
	 */
	it("removes the released name from the state that is persisted across resume", () => {
		const manager = managerWith(pathRule());
		manager.markInjectedByNames(["path-rule"]);
		expect(manager.getInjectedRuleNames()).toEqual(["path-rule"]);

		manager.releaseInjectedByNames(["path-rule"]);

		expect(manager.getInjectedRuleNames()).toEqual([]);
	});

	it("releases only the named rule and leaves other claims standing", () => {
		const manager = managerWith(pathRule());
		expect(manager.addRule(pathRule({ name: "other-rule", path: "/rules/other.md" }))).toBe(true);
		manager.markInjectedByNames(["path-rule", "other-rule"]);

		manager.releaseInjectedByNames(["path-rule"]);

		expect(manager.getInjectedRuleNames()).toEqual(["other-rule"]);
		expect(matchNames(manager)).toEqual(["path-rule"]);
	});

	it("ignores a blank or unknown name rather than throwing mid-abort", () => {
		// This runs on the abort/error path, where a throw would replace the user's real failure.
		const manager = managerWith(pathRule());
		manager.markInjectedByNames(["path-rule"]);

		expect(() => manager.releaseInjectedByNames(["", "   ", "never-registered"])).not.toThrow();

		expect(manager.getInjectedRuleNames()).toEqual(["path-rule"]);
	});

	it("is idempotent, so a double abort does not resurrect a delivered reminder", () => {
		const manager = managerWith(pathRule());
		manager.markInjectedByNames(["path-rule"]);

		manager.releaseInjectedByNames(["path-rule"]);
		manager.releaseInjectedByNames(["path-rule"]);

		expect(manager.getInjectedRuleNames()).toEqual([]);
	});

	/**
	 * Source lock: the bucket must never be cleared without going through the release. Three separate
	 * sites cleared it — the deferred-injection queue and both post-prompt retry paths — and each one
	 * that forgets the release reintroduces the defect on its own.
	 */
	it("is the only way the tool-scoped bucket is cleared", () => {
		const source = fs.readFileSync(AGENT_SESSION, "utf8");

		// One clear() in the whole file, and it sits inside the dropper.
		expect(source.match(/#perToolTtsrInjections\.clear\(\)/g)?.length).toBe(1);
		const dropper = source.slice(source.indexOf("#dropUndeliveredPerToolInjections(): void {"));
		const body = dropper.slice(0, dropper.indexOf("\n\t}"));
		expect(body).toContain("#perToolTtsrInjections.clear()");
		expect(body).toContain("releaseInjectedByNames");
		expect(source.match(/#dropUndeliveredPerToolInjections\(\);/g)?.length).toBe(3);
	});
});

describe("C: a rule's own repeat policy", () => {
	/** The global default stays exactly as it was for a rule that expresses no preference. */
	it("falls back to the global setting when the rule states none", () => {
		const manager = managerWith(pathRule());
		expect(matchNames(manager)).toEqual(["path-rule"]);
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual([]);
	});

	/**
	 * THE fix for the reported symptom: navigational advice applies again to the next project, so the
	 * rule may say so even though the global default retires a rule after one injection.
	 */
	it("lets a rule opt out of the global once-per-session default", () => {
		const manager = managerWith(pathRule({ repeatMode: "after-gap", repeatGap: 0 }));
		expect(matchNames(manager)).toEqual(["path-rule"]);
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual(["path-rule"]);
	});

	it("holds the rule's own gap, counted in messages since the injection", () => {
		const manager = managerWith(pathRule({ repeatMode: "after-gap", repeatGap: 2 }), { repeatGap: 0 });
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual([]);
		manager.incrementMessageCount();
		expect(matchNames(manager)).toEqual([]);
		manager.incrementMessageCount();
		expect(matchNames(manager)).toEqual(["path-rule"]);
	});

	/** Per-rule wins in BOTH directions, or it is a preference the rule author cannot rely on. */
	it("can also pin a rule to once while the operator's global setting repeats", () => {
		const manager = managerWith(pathRule({ repeatMode: "once" }), { repeatMode: "after-gap", repeatGap: 0 });
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual([]);
	});

	it("ignores the rule's gap when the rule pins the mode to once", () => {
		const manager = managerWith(pathRule({ repeatMode: "once", repeatGap: 0 }));
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual([]);
	});

	/** A rule that gives a gap and no mode is still governed by the global mode. */
	it("does not turn a global once into a repeat just because a gap is present", () => {
		const manager = managerWith(pathRule({ repeatGap: 0 }));
		manager.markInjectedByNames(["path-rule"]);

		expect(matchNames(manager)).toEqual([]);
	});
});

describe("C: parsing a repeat policy out of rule frontmatter", () => {
	function parse(frontmatter: string): Rule {
		return buildRuleFromMarkdown("parsed-rule", `---\n${frontmatter}\n---\n\nbody\n`, "/rules/parsed-rule.md", {
			provider: "test",
			providerName: "test",
			path: "/rules/parsed-rule.md",
			level: "project",
		});
	}

	it("reads both fields off the frontmatter", () => {
		const rule = parse('condition: "x"\nrepeatMode: after-gap\nrepeatGap: 8');

		expect(rule.repeatMode).toBe("after-gap");
		expect(rule.repeatGap).toBe(8);
	});

	it("leaves both undefined when the rule says nothing, so the global setting governs", () => {
		const rule = parse('condition: "x"');

		expect(rule.repeatMode).toBeUndefined();
		expect(rule.repeatGap).toBeUndefined();
	});

	it("accepts a zero gap, which means every match may fire", () => {
		// Zero is a real value here and the falsy trap is easy to write, so it is pinned separately.
		expect(parse('condition: "x"\nrepeatGap: 0').repeatGap).toBe(0);
	});

	it("ignores a mode it does not recognise instead of storing it", () => {
		// An unknown mode must not become a third policy by accident; the global setting governs.
		expect(parse('condition: "x"\nrepeatMode: sometimes').repeatMode).toBeUndefined();
		expect(parse('condition: "x"\nrepeatMode: 3').repeatMode).toBeUndefined();
	});

	it("ignores a gap that is not a whole non-negative count", () => {
		// A negative gap is not a smaller gap and a fractional one is not a count; both are typos, and
		// silently coercing either would invent a policy the author did not write.
		expect(parse('condition: "x"\nrepeatGap: -1').repeatGap).toBeUndefined();
		expect(parse('condition: "x"\nrepeatGap: 1.5').repeatGap).toBeUndefined();
		expect(parse('condition: "x"\nrepeatGap: "8"').repeatGap).toBeUndefined();
	});
});

describe("the bundled cwd-reroot rule", () => {
	/**
	 * The whole point of the three fixes, asserted on the shipped rule rather than on a fixture: it
	 * takes the tool-scoped delivery path, and it repeats, so the second foreign project a session
	 * touches gets the same advice as the first.
	 */
	it("repeats, because its advice applies again to the next project", async () => {
		const rule = await builtinRule("cwd-reroot");

		expect(rule.interruptMode).toBe("never");
		expect(rule.repeatMode).toBe("after-gap");
		expect(rule.repeatGap).toBeGreaterThan(0);
	});

	it("fires a second time for a different project under the global once default", async () => {
		const manager = managerWith(await builtinRule("cwd-reroot"));

		expect(matchNames(manager)).toEqual(["cwd-reroot"]);
		manager.markInjectedByNames(["cwd-reroot"]);
		for (let i = 0; i < 8; i++) manager.incrementMessageCount();

		expect(matchNames(manager, '{"path":"/work/third-project/src/lib/main.rs"}')).toEqual(["cwd-reroot"]);
	});
});
