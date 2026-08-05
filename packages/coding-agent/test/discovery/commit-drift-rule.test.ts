/**
 * The `commit-drift` bundled rule: its firing contract, and the gate that keeps it free.
 *
 * The rule's whole claim is that it costs nothing until drift is real. That claim rests
 * on ONE mechanism: the body is wrapped in `{{#if commitDrift}}`, so with no drift it
 * renders to the empty string and `#deliverableTtsrMatches` drops the match before it is
 * claimed, delivered, or billed. The negative control below is therefore not a nicety —
 * remove the gate and the rule ships an empty `<system-reminder>` on every edit, marks
 * itself injected, and never fires again for the rest of the session.
 *
 * Renders the REAL bundled markdown through the REAL template renderer, so a change to
 * the rule's own text that breaks the gate fails here rather than in a live session.
 */

import { describe, expect, test } from "bun:test";
import { prompt } from "@veyyon/utils";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../../src/capability/rule";
import { loadCapability } from "../../src/discovery";
import { BUILTIN_RULE_SOURCES } from "../../src/discovery/builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "../../src/discovery/helpers";
import { TtsrManager } from "../../src/export/ttsr";

const NAME = "commit-drift";

function bundledRule(): Rule {
	const source = BUILTIN_RULE_SOURCES.find(candidate => candidate.name === NAME);
	if (!source) throw new Error(`${NAME} is not registered in BUILTIN_RULE_SOURCES`);
	const virtualPath = `${BUILTIN_DEFAULTS_PROVIDER_ID}:${NAME}.md`;
	return buildRuleFromMarkdown(
		NAME,
		source.content,
		virtualPath,
		createSourceMeta(BUILTIN_DEFAULTS_PROVIDER_ID, virtualPath, "user"),
		{ ruleName: NAME },
	);
}

/** The same call `#renderRuleBody` makes, with only the field this rule reads. */
function render(commitDrift: { count: number; files: string } | null): string {
	return prompt.render(bundledRule().content, { commitDrift });
}

describe("the gate that makes the rule free", () => {
	/**
	 * THE negative control. With no drift the body must render to nothing, because
	 * "nothing" is precisely what `#deliverableTtsrMatches` tests for when it decides not
	 * to deliver. A rule that rendered even one line here would fire on every single
	 * edit tool call for the whole session.
	 */
	test("renders nothing at all when there is no drift to report", () => {
		expect(render(null).trim()).toBe("");
	});

	/**
	 * With drift, the reminder must carry the NUMBER and the PATHS. Those are the two
	 * things the model cannot see for itself and the entire reason the rule beats the
	 * static "commit often" sentence it replaced.
	 */
	test("names the count and the exact files once drift is real", () => {
		const body = render({ count: 7, files: "src/a.ts, src/b.ts, and 5 more" });
		expect(body).toContain("7 files");
		expect(body).toContain("src/a.ts, src/b.ts, and 5 more");
		expect(body.trim().length).toBeGreaterThan(0);
	});

	/**
	 * The three instructions that keep the nudge from causing damage. Dropping any one
	 * turns a helpful reminder into a harmful one: an ungated commit is broken, `git
	 * add -A` sweeps up another lane's work, and an unrequested push is not the agent's
	 * call to make.
	 */
	test("carries the guardrails that make acting on it safe", () => {
		const body = render({ count: 5, files: "a.ts" });
		expect(body).toContain("git add -A");
		expect(body).toContain("Do not push");
		expect(body).toMatch(/Green first/);
	});
});

describe("when the rule can fire", () => {
	/**
	 * Scope and mode decide the cost. `interruptMode: never` folds the reminder into the
	 * tool result instead of aborting a stream mid-sentence, and the edit-tool scope is
	 * what keeps it off every read, grep, and bash call. A rule that matched everything
	 * would evaluate its condition on every tool call in the session.
	 */
	test("is scoped to the edit tools and never interrupts the stream", () => {
		const rule = bundledRule();
		expect(rule.interruptMode).toBe("never");
		expect(rule.scope).toEqual(expect.arrayContaining(["tool:edit", "tool:write", "tool:ast_edit"]));
	});

	/**
	 * The scope declared in frontmatter has to survive the REAL matcher, not merely read
	 * correctly: a scope string the manager does not parse the way it looks produces a
	 * rule that is registered, listed, documented, and silent. Asserted through
	 * `TtsrManager` so the answer comes from the matcher a session uses.
	 */
	test("fires on an edit-tool stream and stays quiet on a read", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 10,
		});
		expect(manager.addRule(bundledRule())).toBe(true);

		manager.resetBuffer();
		const onEdit = manager.checkDelta('{"path":"src/a.ts"}', { source: "tool", toolName: "edit" });
		expect(onEdit.map(rule => rule.name)).toContain(NAME);

		manager.resetBuffer();
		const onRead = manager.checkDelta('{"path":"src/a.ts"}', { source: "tool", toolName: "read" });
		expect(onRead.map(rule => rule.name)).not.toContain(NAME);
	});

	/**
	 * `once` (the global default) would let the reminder fire one time per session and
	 * then go quiet for a session that keeps drifting, which is the case it exists for.
	 * `after-gap` with a real gap is what makes it recurring without being noise.
	 */
	test("repeats after a gap rather than firing once per session", () => {
		const rule = bundledRule();
		expect(rule.repeatMode).toBe("after-gap");
		expect(rule.repeatGap ?? 0).toBeGreaterThanOrEqual(10);
	});
});

describe("how the rule is shipped", () => {
	/**
	 * Registration is what makes it exist. A rule markdown file that nobody added to
	 * `BUILTIN_RULE_SOURCES` is embedded nowhere and loads in no session, and the failure
	 * is silent: the feature is simply absent.
	 */
	test("loads from the bundled defaults provider, on by default", async () => {
		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: process.cwd() });
		const loaded = result.items.find(rule => rule.name === NAME);
		expect(loaded).toBeDefined();
		expect(loaded?._source?.provider).toBe(BUILTIN_DEFAULTS_PROVIDER_ID);
	});
});
