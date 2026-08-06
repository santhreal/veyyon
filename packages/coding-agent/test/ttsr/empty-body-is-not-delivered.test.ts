/**
 * A rule that matches but renders to nothing is dropped before it costs anything.
 *
 * WHY THIS SUITE EXISTS. A rule body may be entirely wrapped in a `{{#if}}` gate, because the advice
 * only applies when a feature is on: `argot-load-nudge` tells the model to call `argot_load`, a tool
 * that does not exist unless `argot.enabled` is set. When the gate is closed the body renders to the
 * empty string, and delivering that is worse than not firing at all. An empty `<system-reminder>`
 * spends tokens, interrupts the stream on the interrupting path, gets the rule marked as injected so
 * it cannot fire when the gate later opens, and tells the model a rule was violated without naming a
 * behaviour to change.
 *
 * That gate is also why `argot-load-nudge` shipped in the source tree and in every published tarball
 * WITHOUT being registered: registering it as it stood would have injected an empty reminder on every
 * default install. It was dead weight instead, a bundled rule that could not fire. Both halves are
 * fixed here, so both halves are pinned: the drop is a general contract of the delivery path, and the
 * rule is registered and gated on a condition that is true only when its advice can be acted on.
 *
 * The gate is `argotUnloaded`, not `argot`, and that distinction is asserted below. Whether the
 * feature is ON and whether the dictionary is already LOADED are different questions, and advising a
 * model to load a dictionary it has already loaded is advice it cannot act on. The template language
 * has no `unless`, so the condition arrives pre-inverted.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getCapability } from "@veyyon/coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@veyyon/coding-agent/capability/rule";
import type { LoadContext } from "@veyyon/coding-agent/capability/types";
import { BUILTIN_RULE_SOURCES } from "@veyyon/coding-agent/discovery/builtin-rules/index";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { prompt } from "@veyyon/utils";
import "@veyyon/coding-agent/discovery";

const AGENT_SESSION = path.join(import.meta.dir, "../../src/session/agent-session.ts");
const RULES_DIR = path.join(import.meta.dir, "../../src/discovery/builtin-rules");

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

/** Render a body the way the session does, with both argot gates set explicitly. */
function render(rule: Rule, gates: { argot: boolean; argotUnloaded: boolean }): string {
	return prompt.render(rule.content, { ...gates, cwd: "/work/project", matchedPath: undefined });
}

describe("the argot-load-nudge rule", () => {
	/**
	 * It existed as a file nobody loaded. Nothing failed, because nothing checked: a bundled rule that
	 * is absent from `BUILTIN_RULE_SOURCES` is simply never seen again.
	 */
	it("is registered, so it can actually fire", async () => {
		expect(BUILTIN_RULE_SOURCES.map(s => s.name)).toContain("argot-load-nudge");
		expect((await loadBuiltinRules()).map(r => r.name)).toContain("argot-load-nudge");
	});

	/**
	 * Every `.md` beside it has to be registered too, which is the check whose absence let this one sit
	 * unloaded. A rule file is only ever added for a reason, so an unregistered one is a mistake and
	 * not a style; the alternative to this test is discovering the next one by accident.
	 */
	it("is not the last unregistered rule file, because every rule file is registered", () => {
		const files = fs
			.readdirSync(RULES_DIR, { recursive: true, encoding: "utf8" })
			.filter(name => name.endsWith(".md"))
			.map(name => path.basename(name, ".md"))
			.sort();

		expect(BUILTIN_RULE_SOURCES.map(s => s.name).toSorted()).toEqual(files);
	});

	/** It matches on an edit, which is the moment its advice is worth acting on. */
	it("matches on an edit stream", async () => {
		const manager = new TtsrManager(undefined, { getCwd: () => "/work/project" });
		expect(manager.addRule(await builtinRule("argot-load-nudge"))).toBe(true);

		const matched = manager.checkDelta('{"path":"src/main.ts","oldText":"a","newText":"b"}', {
			source: "tool",
			toolName: "edit",
		});

		expect(matched.map(r => r.name)).toEqual(["argot-load-nudge"]);
	});

	it("says nothing when argot is off, so a default install gets no dead advice", async () => {
		const rule = await builtinRule("argot-load-nudge");

		expect(render(rule, { argot: false, argotUnloaded: false }).trim()).toBe("");
	});

	/**
	 * The distinction that makes the nudge truthful: the feature being ON is not the same as the
	 * dictionary being UNLOADED. Gating on `argot` alone would nudge the model to load a dictionary it
	 * loaded ten turns ago, every time it edited a file.
	 */
	it("says nothing when argot is on and the dictionary is already loaded", async () => {
		const rule = await builtinRule("argot-load-nudge");

		expect(render(rule, { argot: true, argotUnloaded: false }).trim()).toBe("");
	});

	it("names the tool to call, and how to call it, when the dictionary is not loaded", async () => {
		const rule = await builtinRule("argot-load-nudge");

		const rendered = render(rule, { argot: true, argotUnloaded: true });

		expect(rendered).toContain('argot_load(folder_path: ".")');
		expect(rendered).toContain("§handle");
		expect(rendered).not.toContain("{{");
	});
});

describe("the delivery path's empty-body guard", () => {
	/**
	 * Source lock, because the filter runs inside `#handleTtsrMatches` on state a test cannot reach.
	 * It has to sit at the top of that method: the two things that must not happen for an undeliverable
	 * rule are the claim (`markInjectedByNames`, via bucketing) and the `ttsr_triggered` event, and both
	 * happen further down.
	 */
	it("runs before anything is claimed or emitted", () => {
		const source = fs.readFileSync(AGENT_SESSION, "utf8");
		// The DECLARATION, not the call site: the call comes first in the file.
		const method = source.slice(source.indexOf("#handleTtsrMatches(\n\t\trawMatches: Rule[],"));
		const body = method.slice(0, method.indexOf("\n\t}"));

		const filterAt = body.indexOf("#deliverableTtsrMatches(rawMatches)");
		expect(filterAt).toBeGreaterThan(-1);
		expect(filterAt).toBeLessThan(body.indexOf("#addPerToolTtsrInjections("));
		expect(filterAt).toBeLessThan(body.indexOf("#addPendingTtsrInjections("));
		expect(filterAt).toBeLessThan(body.indexOf('type: "ttsr_triggered"'));
		// And an all-empty match set ends the call rather than falling through to an abort.
		expect(body).toContain("if (matches.length === 0)");
	});

	/**
	 * The guard decides on the RENDERED body, so it must use the one renderer. Testing `rule.content`
	 * would pass for a gated body that renders to nothing, which is the only case that matters.
	 */
	it("decides on the rendered body, not the raw one", () => {
		const source = fs.readFileSync(AGENT_SESSION, "utf8");
		const method = source.slice(source.indexOf("#deliverableTtsrMatches(matches: Rule[]): Rule[] {"));
		const body = method.slice(0, method.indexOf("\n\t}"));

		expect(body).toContain("this.#renderRuleBody(rule)");
		expect(body).not.toContain("rule.content.trim()");
	});

	/**
	 * A closed gate is the gate working and it recurs on every match, so it is reported at debug. A
	 * body with no gate that renders empty can never say anything, which is a packaging bug in the
	 * rule and has to reach an operator. One message, two levels, and the level is the finding.
	 */
	it("reports a closed gate at debug and an ungated empty body at warn", () => {
		const source = fs.readFileSync(AGENT_SESSION, "utf8");
		const method = source.slice(source.indexOf("#deliverableTtsrMatches(matches: Rule[]): Rule[] {"));
		const body = method.slice(0, method.indexOf("\n\t}"));

		expect(body).toContain('rule.content.includes("{{#if")');
		expect(body).toContain("if (gated) logger.debug(message, fields);");
		expect(body).toContain("else logger.warn(message, fields);");
	});

	/** The session's render context has to supply the gate the bundled rule reads, or rendering throws. */
	it("renders with the argotUnloaded gate the bundled rule reads", () => {
		const source = fs.readFileSync(AGENT_SESSION, "utf8");
		const method = source.slice(source.indexOf("#renderRuleBody(rule: Rule): string {"));
		const body = method.slice(0, method.indexOf("\n\t}"));

		expect(body).toContain("argotUnloaded: argotEnabled && this.#argot?.loaded !== true");
	});
});
