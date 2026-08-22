/**
 * Every bundled rule's condition compiles, tool-scoped rules choose an interrupt policy, and
 * `irc-signal` fires on the traffic it exists for.
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
 * The remaining tests pin `irc-signal`'s behavior, which exists because subagents wake each other
 * with acknowledgements and progress reports: a message stops an idle peer, costs it a full turn,
 * and changes nothing it does, which is also how a two-agent loop sustains itself.
 *
 * The quiet cases are not decoration. A rule that fires on every IRC message would be worse than
 * no rule, because it would train the model to ignore the reminder, so a substantive message
 * naming a file or a decision MUST NOT trip it.
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

/** The streamed tool-argument text a TTSR condition is matched against. */
function ircArgs(message: string): string {
	return JSON.stringify({ op: "send", to: "Main", message });
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

describe("irc-signal", () => {
	const rule = ruleNamed("irc-signal");
	const patterns = rule.condition ?? [];
	const condition = new RegExp(patterns.length === 1 ? patterns[0]! : "(?!)");

	it("is scoped to the irc tool, so it never fires on file edits", () => {
		expect(rule.scope).toContain("tool:irc");
	});

	it.each([
		["a bare acknowledgement", "Ack"],
		["an agreement", "Understood, will do"],
		["a receipt", "Noted, thanks"],
		["an announcement of work", "Starting on the parser now"],
		["a progress report", "Quick update: still working on the parser"],
		["a status line", "Status update: 3 of 5 files done"],
	])("fires on %s", (_label, message) => {
		expect(condition.test(ircArgs(message))).toBe(true);
	});

	it.each([
		["a fact with a location", "agent-session.ts:8992 drops a tool missing from the registry with no log"],
		["a file claim", "I need packages/ai/src/providers/cursor.ts, are you holding it?"],
		["a named decision", "Do we cap the retry ladder at 5 minutes or read the provider window?"],
		["a refusal", "I will not weaken that assertion; the contract is the exit byte"],
	])("stays quiet on %s", (_label, message) => {
		expect(condition.test(ircArgs(message))).toBe(false);
	});
});
