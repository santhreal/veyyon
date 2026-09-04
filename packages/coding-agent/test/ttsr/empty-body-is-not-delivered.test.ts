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

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_RULE_SOURCES } from "@veyyon/coding-agent/discovery/builtin-rules/index";
import { getCapability } from "@veyyon/coding-agent/discovery/capability";
import {
	BUILTIN_DEFAULTS_PROVIDER_ID,
	type Rule,
	ruleCapability,
} from "@veyyon/coding-agent/discovery/capability/rule";
import type { LoadContext } from "@veyyon/coding-agent/discovery/capability/types";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { logger, prompt } from "@veyyon/utils";
import "@veyyon/coding-agent/discovery";
import { deliveredText, ttsrHarness } from "../helpers/ttsr-runtime";

/** The one message both empty-body levels report; the LEVEL is the finding, not the text. */
const EMPTY_BODY_MESSAGE = "TTSR rule matched but its body renders empty, not delivering";
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
	afterEach(() => {
		mock.restore();
	});

	/** A rule that says nothing when its gate is closed, and says something when it opens. */
	function gatedRule(overrides: Partial<Rule> = {}): Rule {
		return {
			name: "gated-rule",
			path: "/rules/gated-rule.md",
			content: "{{#if argotUnloaded}}Load the dictionary with `argot_load`.{{/if}}",
			condition: ["TRIGGER"],
			_source: { provider: "test", providerName: "test", path: "/rules/gated-rule.md", level: "project" },
			...overrides,
		};
	}

	/**
	 * The claim and the `ttsr_triggered` event are the two things an undeliverable rule must not
	 * cost. Both happen downstream of the filter, so a filter that ran late would leave the rule
	 * marked injected — permanently, under the default `repeatMode: "once"` — having shown nothing.
	 */
	it("claims nothing, emits nothing and aborts nothing for an undeliverable rule", async () => {
		const h = ttsrHarness([gatedRule()], { argotEnabled: false });

		expect(await h.delta("TRIGGER")).toBe(false);

		expect(h.recorded.events).toEqual([]);
		expect(h.recorded.aborts).toEqual([]);
		expect(h.manager.getInjectedRuleNames()).toEqual([]);
	});

	/** And the same rule fires the moment its gate opens, so the drop is the gate and not a retirement. */
	it("delivers the same rule once its gate opens", async () => {
		const h = ttsrHarness([gatedRule()], { argotEnabled: true, argotLoaded: false });

		expect(await h.delta("TRIGGER")).toBe(true);

		expect(h.recorded.events.map(e => e.event.type)).toEqual(["ttsr_triggered"]);
		expect(h.recorded.aborts).toHaveLength(1);
	});

	/**
	 * The guard decides on the RENDERED body. Deciding on `rule.content` would pass for a gated body
	 * that renders to nothing, which is the only case that matters: raw markup is a non-empty string.
	 */
	it("decides on the rendered body, not the raw one", async () => {
		const raw = gatedRule().content;
		expect(raw.length).toBeGreaterThan(0);

		const closed = ttsrHarness([gatedRule()], { argotEnabled: false });
		expect(await closed.delta("TRIGGER")).toBe(false);

		const open = ttsrHarness([gatedRule()], { argotEnabled: true });
		expect(await open.delta("TRIGGER")).toBe(true);
	});

	/**
	 * A closed gate is the gate working and it recurs on every match, so it is reported at debug. A
	 * body with no gate that renders empty can never say anything, which is a packaging bug in the
	 * rule and has to reach an operator. One message, two levels, and the level is the finding.
	 */
	it("reports a closed gate at debug and an ungated empty body at warn", async () => {
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		await ttsrHarness([gatedRule()], { argotEnabled: false }).delta("TRIGGER");
		expect(debug.mock.calls.map(([message]) => message)).toContain(EMPTY_BODY_MESSAGE);
		expect(warn.mock.calls.map(([message]) => message)).not.toContain(EMPTY_BODY_MESSAGE);

		debug.mockClear();
		warn.mockClear();
		await ttsrHarness([gatedRule({ content: "   " })], { argotEnabled: false }).delta("TRIGGER");
		expect(warn.mock.calls.map(([message]) => message)).toContain(EMPTY_BODY_MESSAGE);
		expect(debug.mock.calls.map(([message]) => message)).not.toContain(EMPTY_BODY_MESSAGE);
	});

	/**
	 * `argotUnloaded` is the gate, not `argot`. Whether the feature is ON and whether the dictionary
	 * is already LOADED are different questions, and advising a model to load one it has already
	 * loaded is advice it cannot act on. The delivered text is what proves which gate was consulted.
	 */
	it("renders with the argotUnloaded gate, so an already-loaded dictionary says nothing", async () => {
		const unloaded = ttsrHarness([gatedRule()], { argotEnabled: true, argotLoaded: false });
		expect(await unloaded.delta("TRIGGER")).toBe(true);
		await unloaded.drain();
		const delivered = deliveredText(unloaded.recorded.appended.at(0));
		expect(delivered).toContain("argot_load");

		const loaded = ttsrHarness([gatedRule()], { argotEnabled: true, argotLoaded: true });
		expect(await loaded.delta("TRIGGER")).toBe(false);
		expect(loaded.recorded.aborts).toEqual([]);
	});

	/**
	 * Both delivery paths render through one owner, so neither can regress to folding a RAW body in.
	 * A behavioural assertion sees this now that the paths are reachable: unresolved `{{` markup is
	 * still a non-empty string, so only the delivered text distinguishes the two.
	 */
	it("delivers resolved text on both the interrupting and the tool-scoped path", async () => {
		const interrupting = ttsrHarness([gatedRule()], { argotEnabled: true });
		expect(await interrupting.delta("TRIGGER")).toBe(true);
		await interrupting.drain();
		const injected = deliveredText(interrupting.recorded.appended.at(0));
		expect(injected).not.toContain("{{");

		const scoped = ttsrHarness([gatedRule({ interruptMode: "never" })], { argotEnabled: true });
		expect(await scoped.delta("TRIGGER")).toBe(false);
		const reminder = scoped.runtime.afterToolCall({
			toolCall: { id: "call-1", name: "read", type: "toolCall", arguments: {} },
			isError: false,
		} as never);
		expect(reminder).toBeUndefined();
		expect(deliveredText(scoped.runtime.takePendingToolReminders())).not.toContain("{{");
	});
});
