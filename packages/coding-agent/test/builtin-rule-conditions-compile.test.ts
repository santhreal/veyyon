/**
 * Every bundled rule's condition compiles, and tool-scoped rules choose an interrupt policy.
 *
 * WHY THIS SUITE EXISTS. A bundled rule can fail in three quiet ways.
 *
 * It can be UNREGISTERED. `builtin-rules/index.ts` imports each markdown file by name and lists it
 * in `BUILTIN_RULE_SOURCES`, because the compiled binary ships no loose rule files. Dropping a new
 * `.md` into `builtin-rules/workflow/` therefore ships nothing at all: the file is in the tree, it
 * reads correctly, and no session ever loads it. Nothing warns, because nothing looked.
 *
 * It can be UNCOMPILABLE. The condition is a regex string in frontmatter. A malformed one throws
 * where the rule is evaluated rather than where it is declared, so the rule that never fires looks
 * like a rule whose pattern simply did not match.
 *
 * The first test closes both dead-rule cases for every bundled rule at once.
 *
 * A tool-scoped rule that inherits the global interrupt mode can silently turn post-tool guidance
 * into a stream abort and retry. Requiring every bundled tool rule to choose a policy closes that
 * omission, and pinning the intentional interrupt list makes a new aborting rule fail by default.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_RULE_SOURCES } from "@veyyon/coding-agent/discovery/builtin-rules/index";
import { buildRuleFromMarkdown, createSourceMeta } from "@veyyon/coding-agent/discovery/helpers";

function ruleNamed(name: string) {
	const source = BUILTIN_RULE_SOURCES.find(entry => entry.name === name);
	if (!source) throw new Error(`bundled rule "${name}" is not registered in BUILTIN_RULE_SOURCES`);
	const meta = createSourceMeta("builtin-defaults", `builtin:${name}`, "user");
	return buildRuleFromMarkdown(name, source.content, `builtin:${name}`, meta, { ruleName: name });
}

describe("bundled rule conditions", () => {
	it("compiles the condition of every registered rule", () => {
		const broken: string[] = [];
		for (const source of BUILTIN_RULE_SOURCES) {
			const rule = ruleNamed(source.name);
			for (const pattern of rule.condition ?? []) {
				try {
					new RegExp(pattern);
				} catch (error) {
					broken.push(`${source.name}: ${(error as Error).message}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("gives every registered rule a body a model can act on", () => {
		const empty = BUILTIN_RULE_SOURCES.filter(source => ruleNamed(source.name).content.trim().length === 0);
		expect(empty.map(source => source.name)).toEqual([]);
	});

	it("makes every tool-scoped rule choose a policy and pins the interrupting exceptions", () => {
		const toolRules = BUILTIN_RULE_SOURCES.flatMap(source => {
			const rule = ruleNamed(source.name);
			return (rule.scope ?? []).some(scope => scope.startsWith("tool:")) ? [{ name: source.name, rule }] : [];
		});
		expect(toolRules.flatMap(({ name, rule }) => (rule.interruptMode === undefined ? [name] : []))).toEqual([]);
		expect(toolRules.flatMap(({ name, rule }) => (rule.interruptMode !== "never" ? [name] : []))).toEqual([
			"ts-no-inline-cast-access",
		]);
	});
});
