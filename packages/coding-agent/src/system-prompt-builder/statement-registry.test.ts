/**
 * The statement registry's contracts: row identity, condition vocabulary,
 * granularity, banner ownership, and complete static-section coverage.
 *
 * This suite checks registry structure. `statement-assembly.test.ts` separately
 * renders the complete modular prompt across the gate matrix, while
 * `statement-wiring.test.ts` proves those modules reach production assembly.
 *
 * These are the claims, each of which was a real way to get it wrong:
 *
 *   - THE GRANULARITY RULE. Two adjacent unconditional statements in one section can always be one
 *     statement, so their split is arbitrary, and arbitrary splits are how a registry drifts from
 *     "the smallest independently varying unit" toward a row per paragraph.
 *   - THE BANNER IS THE ASSEMBLER'S. A statement file containing a banner would produce it twice,
 *     and the byte gate would catch that only for sections already converted.
 *   - THE CLOSED VOCABULARY. A condition naming a variable nothing sets makes a statement that
 *     never appears, and nothing about that is visible: no error, no empty render, just missing
 *     text.
 *   - THE CONDITION EVALUATORS. `whenAll`, `whenAny` and `not` compose, so their edge cases (empty
 *     lists, nesting, negated membership) decide real inclusion and are pinned rather than assumed.
 *   - HANDLEBARS TRUTHINESS. `conditionHolds` has to agree with `{{#if}}` while both exist, or the
 *     byte gate would be comparing two rulesets rather than two spellings of one.
 */
import { describe, expect, it } from "bun:test";
import { PROMPT_GATES } from "./gate-registry";
import { SYSTEM_PROMPT_SECTIONS } from "./section-registry";
import {
	allOf,
	anyOf,
	assembleSection,
	conditionHolds,
	conditionVariables,
	contains,
	describeCondition,
	not,
	PROMPT_STATEMENT_IDS,
	PROMPT_STATEMENTS,
	SESSION_FACT_VARIABLES,
	STATEMENT_SECTIONS,
	type StatementCondition,
	sectionBanner,
	statementById,
	statementsOf,
	when,
} from "./statement-registry";

describe("the rows are well formed", () => {
	it("gives every statement a unique id", () => {
		// Two rows sharing an id would make `statementById` return one of them and an override or an
		// ablation naming that id would hit whichever came first, silently.
		expect(PROMPT_STATEMENT_IDS.length).toBe(new Set(PROMPT_STATEMENT_IDS).size);
	});

	it("names every id `<section>/<slug>`, matching its own section field", () => {
		// The id is also the md file's path under `statements/`, so a row whose id disagrees with its
		// section points at a file that is not where the row says it is.
		for (const statement of PROMPT_STATEMENTS) {
			expect(statement.id, `${statement.id} is not <section>/<slug>`).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
			expect(statement.id.split("/")[0], `${statement.id} disagrees with section ${statement.section}`).toBe(
				statement.section,
			);
		}
	});

	it("puts every statement in a section the section registry declares", () => {
		// A statement in an unregistered section would never be assembled: `buildSystemPrompt` walks
		// sections, so a section nothing declares is a statement nothing reaches.
		const registered = new Set(SYSTEM_PROMPT_SECTIONS.map(entry => entry.id));

		for (const statement of PROMPT_STATEMENTS) {
			expect(registered.has(statement.section), `${statement.section} is not a registered section`).toBe(true);
		}
	});

	it("states a purpose for every statement, saying why it is its own statement", () => {
		// The granularity rule is a judgement, so the judgement is recorded. A row that cannot say
		// why it is separate is usually part of its neighbour.
		for (const statement of PROMPT_STATEMENTS) {
			expect(statement.purpose.length, `${statement.id} has no purpose`).toBeGreaterThan(30);
		}
	});

	it("derives PROMPT_STATEMENT_IDS from the rows rather than restating them", () => {
		expect(PROMPT_STATEMENT_IDS).toEqual(PROMPT_STATEMENTS.map(statement => statement.id));
	});

	it("finds a row by id, and nothing by an id that does not exist", () => {
		expect(statementById("role/mermaid-diagrams")?.section).toBe("role");
		expect(statementById("role/does-not-exist")).toBeUndefined();
		// A prototype key, which a plain index lookup on an object would have answered truthily.
		expect(statementById("toString")).toBeUndefined();
	});
});

describe("the granularity rule is enforced, not just documented", () => {
	it("never leaves two adjacent unconditional statements in one section", () => {
		// Two `always` rows next to each other are always mergeable, so the split between them
		// carries no information. Reported by id so the fix is obvious: merge them, or give the
		// second the condition that made it separate.
		// The exception the rule states: the second row may open a unit the DOCUMENT declares, which is
		// a markdown heading or an XML block. That is what makes DELIVERY CONTRACT's five unconditional
		// contract blocks and EXECUTION WORKFLOW's six numbered steps legitimate separate rows while
		// still reporting two adjacent `always` rows of plain prose, which is the arbitrary split the
		// rule exists to catch.
		const opensADeclaredUnit = (text: string): boolean => {
			const first = text.trimStart();
			return first.startsWith("#") || /^<[a-z][a-z0-9-]*>/.test(first);
		};
		const mergeable: string[] = [];

		for (const section of STATEMENT_SECTIONS) {
			const rows = statementsOf(section);
			for (let i = 1; i < rows.length; i++) {
				const previous = rows[i - 1];
				const current = rows[i];
				if (previous === undefined || current === undefined) continue;
				if (previous.condition.kind !== "always" || current.condition.kind !== "always") continue;
				if (opensADeclaredUnit(current.text)) continue;
				mergeable.push(`${previous.id} + ${current.id}`);
			}
		}

		expect(mergeable, `adjacent unconditional statements to merge: ${mergeable.join(", ")}`).toEqual([]);
	});

	it("keeps the banner out of every statement file", () => {
		// The assembler renders banners from the section registry's names, at one width, in one
		// place. A banner inside a statement would be emitted twice and at whatever width the file
		// happened to carry.
		for (const statement of PROMPT_STATEMENTS) {
			expect(statement.text, `${statement.id} contains a banner rule`).not.toMatch(/^=====+$/m);
			expect(statement.text, `${statement.id} contains a banner rule`).not.toMatch(/^-----+$/m);
		}
	});

	it("ends every statement with a newline and never with more than one blank line", () => {
		// Concatenation with no separator is what makes byte identity achievable, so a statement that
		// did not end with a newline would run into the next one.
		//
		// ONE trailing blank line is allowed, and RUNTIME's conditional blocks use it: a block that
		// appears has to bring its own separation from the next one, because the template's blank
		// lines there are unconditional and a statement cannot own an unconditional byte. TWO is
		// never right, because `format` deletes a run of 2+ blank lines entirely (`prompt.ts`), so a
		// statement ending that way would silently delete the gap it was trying to create.
		for (const statement of PROMPT_STATEMENTS) {
			expect(statement.text.endsWith("\n"), `${statement.id} does not end with a newline`).toBe(true);
			expect(
				statement.text.endsWith("\n\n\n"),
				`${statement.id} ends with two blank lines, which format deletes`,
			).toBe(false);
		}
	});
});

describe("a condition cannot name a variable nothing provides", () => {
	/** Every variable a setting feeds the template, from the gate rows. */
	const gateVariables = new Set<string>(PROMPT_GATES.flatMap(gate => [...gate.variables]));

	it("resolves every condition variable to a gate or a declared session fact", () => {
		// The closed vocabulary. A typo, or a variable that was renamed in the builder and not here,
		// produces a statement that never appears and reports nothing. This is the check that turns
		// that into a build failure.
		const unresolved = PROMPT_STATEMENTS.flatMap(statement =>
			conditionVariables(statement.condition)
				.filter(variable => !gateVariables.has(variable) && !Object.hasOwn(SESSION_FACT_VARIABLES, variable))
				.map(variable => `${statement.id} names ${variable}`),
		);

		expect(unresolved, `conditions on variables nothing provides: ${unresolved.join(", ")}`).toEqual([]);
	});

	it("documents where every declared session fact comes from", () => {
		// The list exists to answer "is this a real variable", which it can only do if each row says
		// what sets it. An undocumented row would make the check above pass on a guess.
		for (const [variable, origin] of Object.entries(SESSION_FACT_VARIABLES)) {
			expect(origin.length, `${variable} has no stated origin`).toBeGreaterThan(20);
		}
	});

	it("keeps the session facts disjoint from the settings gates", () => {
		// A variable in both lists has two claimed owners, and the reader cannot tell whether a
		// setting controls it. That is the ONE PLACE failure this whole area was cleaned up for.
		const both = Object.keys(SESSION_FACT_VARIABLES).filter(variable => gateVariables.has(variable));

		expect(both, `variables claimed by both a gate and a session fact: ${both.join(", ")}`).toEqual([]);
	});
});

describe("the condition vocabulary evaluates as the template does", () => {
	it("includes an `always` statement whatever the context says", () => {
		expect(conditionHolds({ kind: "always" }, {})).toBe(true);
		expect(conditionHolds({ kind: "always" }, { anything: false })).toBe(true);
	});

	it("matches Handlebars truthiness, where an empty array and an empty string are false", () => {
		// `{{#if skills.length}}` is what the template writes, so `when("skills")` has to be false
		// for `[]`. Getting this wrong would include a skills block with no skills in it.
		expect(conditionHolds(when("skills"), { skills: [] })).toBe(false);
		expect(conditionHolds(when("skills"), { skills: [{ name: "a" }] })).toBe(true);
		expect(conditionHolds(when("x"), { x: "" })).toBe(false);
		expect(conditionHolds(when("x"), { x: "text" })).toBe(true);
		expect(conditionHolds(when("x"), { x: 0 })).toBe(false);
		expect(conditionHolds(when("x"), { x: 1 })).toBe(true);
		expect(conditionHolds(when("x"), {})).toBe(false);
	});

	it("tests membership against an array, a Set and a Map, which is what tools arrive as", () => {
		// `{{#has tools "task"}}` is asked of the tool collection, and that collection is a Map on
		// the session path and an array on the inspection path. Both have to answer the same.
		expect(conditionHolds(contains("tools", "task"), { tools: ["task", "read"] })).toBe(true);
		expect(conditionHolds(contains("tools", "task"), { tools: new Set(["task"]) })).toBe(true);
		expect(conditionHolds(contains("tools", "task"), { tools: new Map([["task", {}]]) })).toBe(true);
		expect(conditionHolds(contains("tools", "task"), { tools: ["read"] })).toBe(false);
		expect(conditionHolds(contains("tools", "task"), { tools: undefined })).toBe(false);
	});

	it("negates, which is how a block-level `{{else}}` arm is expressed", () => {
		expect(conditionHolds(not(when("toolListMode")), { toolListMode: false })).toBe(true);
		expect(conditionHolds(not(when("toolListMode")), { toolListMode: true })).toBe(false);
		expect(conditionHolds(not(contains("tools", "ask")), { tools: ["read"] })).toBe(true);
	});

	it("requires every nested condition under `whenAll`", () => {
		const delegationGates = allOf(contains("tools", "task"), when("hasSpawnableSubagent"));

		expect(conditionHolds(delegationGates, { tools: ["task"], hasSpawnableSubagent: true })).toBe(true);
		expect(conditionHolds(delegationGates, { tools: ["task"], hasSpawnableSubagent: false })).toBe(false);
		expect(conditionHolds(delegationGates, { tools: [], hasSpawnableSubagent: true })).toBe(false);
	});

	it("expresses `A and not B`, the shape a flat variable list could not say", () => {
		// Full descriptors render only when at least one tool exists and native
		// schema mode is off. This is the exact reason the forms compose.
		const inventoryText = allOf(when("hasTools"), not(when("toolListMode")));

		expect(conditionHolds(inventoryText, { hasTools: true, toolListMode: false })).toBe(true);
		expect(conditionHolds(inventoryText, { hasTools: true, toolListMode: true })).toBe(false);
		expect(conditionHolds(inventoryText, { hasTools: false, toolListMode: false })).toBe(false);
	});

	it("accepts any nested condition under `whenAny`", () => {
		// `{{#ifAny skills.length rules.length}}` at line 188, which gates one bullet.
		const readFirst = anyOf(when("skills"), when("rules"));

		expect(conditionHolds(readFirst, { skills: [{ name: "a" }], rules: [] })).toBe(true);
		expect(conditionHolds(readFirst, { skills: [], rules: [{ name: "r" }] })).toBe(true);
		expect(conditionHolds(readFirst, { skills: [], rules: [] })).toBe(false);
	});

	it("nests to any depth, so a three-level template block is expressible", () => {
		const deep = allOf(
			when("hasTools"),
			anyOf(when("mcpDiscoveryMode"), allOf(when("toolListMode"), not(when("x")))),
		);

		expect(conditionHolds(deep, { hasTools: true, mcpDiscoveryMode: true })).toBe(true);
		expect(conditionHolds(deep, { hasTools: true, toolListMode: true })).toBe(true);
		expect(conditionHolds(deep, { hasTools: true, toolListMode: true, x: true })).toBe(false);
		expect(conditionHolds(deep, { hasTools: true })).toBe(false);
	});

	it("reads an empty `whenAll` as always and an empty `whenAny` as never", () => {
		// Decided rather than inherited from whichever built-in was reached for: a statement gated on
		// nothing is ungated, and a statement gated on none-of-these can never appear.
		expect(conditionHolds({ kind: "whenAll", conditions: [] }, {})).toBe(true);
		expect(conditionHolds({ kind: "whenAny", conditions: [] }, {})).toBe(false);
	});
});

describe("conditionVariables reports what a condition reads", () => {
	it("reports nothing for `always`", () => {
		expect(conditionVariables({ kind: "always" })).toEqual([]);
	});

	it("reports the collection for a membership test, not the member", () => {
		// The member is a literal in the row; the collection is what the context has to provide, and
		// this function's callers are asking what the context needs.
		expect(conditionVariables(contains("tools", "task"))).toEqual(["tools"]);
	});

	it("descends into every nested form", () => {
		// The byte-identity matrix uses this to check it exercises every variable a converted
		// statement depends on. A form it failed to descend into would drop out of that coverage
		// silently, which is why this is asserted per form rather than on one example.
		expect(conditionVariables(not(when("a")))).toEqual(["a"]);
		expect(conditionVariables(allOf(when("a"), when("b")))).toEqual(["a", "b"]);
		expect(conditionVariables(anyOf(when("a"), contains("b", "x")))).toEqual(["a", "b"]);
		expect(conditionVariables(allOf(when("a"), not(anyOf(when("b"), when("c")))))).toEqual(["a", "b", "c"]);
	});

	it("handles every kind the type declares, so a new form cannot be forgotten", () => {
		// One case per union member. A form added to `StatementCondition` without a case here makes
		// this list incomplete, and the exhaustive switch in the implementation stops compiling,
		// which is the pair of signals that keeps them together.
		const kinds = new Set<StatementCondition["kind"]>(
			[
				{ kind: "always" } as const,
				when("a"),
				contains("b", "x"),
				allOf(when("a")),
				anyOf(when("a")),
				not(when("a")),
			].map(condition => condition.kind),
		);

		expect([...kinds].sort()).toEqual(["always", "not", "when", "whenAll", "whenAny", "whenContains"]);
	});
});

describe("the builders construct exactly what a literal would", () => {
	it("builds each form identically to its object literal", () => {
		// The builders exist for readability in the rows. If they built anything other than the
		// literal, the rows would mean something different from what they appear to say.
		expect(when("x")).toEqual({ kind: "when", variable: "x" });
		expect(contains("tools", "task")).toEqual({ kind: "whenContains", collection: "tools", member: "task" });
		expect(not(when("x"))).toEqual({ kind: "not", condition: { kind: "when", variable: "x" } });
		expect(allOf(when("a"), when("b"))).toEqual({
			kind: "whenAll",
			conditions: [
				{ kind: "when", variable: "a" },
				{ kind: "when", variable: "b" },
			],
		});
		expect(anyOf(when("a"))).toEqual({ kind: "whenAny", conditions: [{ kind: "when", variable: "a" }] });
	});

	it("evaluates a built condition and its literal twin the same way", () => {
		const built = allOf(when("hasTools"), not(when("toolListMode")));
		const literal: StatementCondition = {
			kind: "whenAll",
			conditions: [
				{ kind: "when", variable: "hasTools" },
				{ kind: "not", condition: { kind: "when", variable: "toolListMode" } },
			],
		};

		for (const context of [{ hasTools: true, toolListMode: false }, { hasTools: true, toolListMode: true }, {}]) {
			expect(conditionHolds(built, context)).toBe(conditionHolds(literal, context));
		}
	});
});

describe("the statement registry completely owns static prompt text", () => {
	/**
	 * The static section set is explicit so adding or removing a prompt region is
	 * a reviewed registry change rather than an accidental row-side effect.
	 */
	it("pins every section assembled from statements", () => {
		expect([...STATEMENT_SECTIONS]).toEqual([
			"conventions",
			"role",
			"runtime",
			"tool-policy",
			"execution-workflow",
			"delivery-contract",
		]);
	});

	/**
	 * Every static section declared by the section registry must own statements.
	 * The outer slot template has no prose fallback for an uncovered section.
	 */
	it("covers every static section the document declares", () => {
		const declared: string[] = SYSTEM_PROMPT_SECTIONS.filter(section => section.source === "template").map(
			section => section.id,
		);
		const covered = [...new Set<string>(PROMPT_STATEMENTS.map(statement => statement.section))];

		expect([...STATEMENT_SECTIONS]).toEqual(declared);
		expect(covered.sort()).toEqual([...declared].sort());
	});

	it("returns a section's statements in row order, and nothing for a name that is not a section", () => {
		expect(statementsOf("role").map(statement => statement.id)).toEqual(["role/principles", "role/mermaid-diagrams"]);
		// Every registered section is converted, so the negative case needs a name that is not one.
		expect(statementsOf("no-such-section")).toEqual([]);
	});

	it("assembles nothing for a section the registry does not know", () => {
		// The assembler is asked for every section as the migration proceeds, so what it does for a
		// section that has no statements yet is a contract rather than an accident: it emits the
		// banner and nothing else. `statement-wiring.test.ts` is what holds the caller to only
		// asking for sections the document declares.
		// An unregistered section has no name to render a banner from, so the assembler emits nothing
		// at all rather than an empty banner. Asserted because "" is the honest answer for a section
		// the registry does not know, and a banner would be inventing one.
		expect(assembleSection("no-such-section", {})).toBe("");
	});
});

/**
 * A CONDITION READS AS ENGLISH, because the surfaces that show a reader why a rule is in the prompt
 * are only useful if the reason is legible.
 *
 * `veyyon prompt --statements` prints this beside each rule's cost, and a cost with no reason next to
 * it is a number nobody can act on: seeing `tool-policy/lsp` at 103 tokens is not actionable until you
 * know it needs `tools has lsp`. The describer lives with the condition type rather than in the CLI so
 * that it must stay exhaustive over that type, which the `never` arm enforces at compile time: a
 * seventh condition form fails to build until it is described, instead of printing "unknown" forever.
 */
describe("a condition describes itself", () => {
	it("names each of the six forms in its own terms", () => {
		expect(describeCondition({ kind: "always" })).toBe("always");
		expect(describeCondition(when("secretsEnabled"))).toBe("secretsEnabled");
		expect(describeCondition(contains("tools", "task"))).toBe("tools has task");
		expect(describeCondition(allOf(when("a"), when("b")))).toBe("a and b");
		expect(describeCondition(anyOf(when("a"), when("b")))).toBe("a or b");
		expect(describeCondition(not(when("a")))).toBe("not a");
	});

	it("parenthesises a negated group, and only where it changes the reading", () => {
		// `not (a and b)` and `not a and b` are different claims, so the parentheses are load-bearing
		// rather than decorative. A negated single variable needs none, and adding them everywhere
		// would make the common case noisier for no gain.
		expect(describeCondition(not(allOf(when("a"), when("b"))))).toBe("not (a and b)");
		expect(describeCondition(not(anyOf(when("a"), when("b"))))).toBe("not (a or b)");
		expect(describeCondition(not(contains("tools", "ask")))).toBe("not tools has ask");
	});

	it("describes the deepest condition the registry actually uses", () => {
		// The delegation arms are four levels of nesting and the reason `whenAll`/`whenAny` hold
		// conditions rather than variable names. If the describer flattened them, the printed reason
		// would be wrong for exactly the rows whose reason is hardest to work out by hand.
		const arm = statementById("tool-policy/delegation-preferred");

		expect(arm).toBeDefined();
		expect(describeCondition(arm?.condition ?? { kind: "always" })).toBe(
			"tools has task and hasSpawnableSubagent and not useCodexTaskPrompt and eagerTasks and not eagerTasksAlways",
		);
	});

	it("agrees with the truth table at the edges", () => {
		// The empty cases are pinned decisions elsewhere in this suite: an empty `whenAll` holds and an
		// empty `whenAny` never does. The description has to say the same thing, or the printed reason
		// contradicts the behaviour.
		expect(describeCondition(allOf())).toBe("always");
		expect(conditionHolds(allOf(), {})).toBe(true);
		expect(describeCondition(anyOf())).toBe("never");
		expect(conditionHolds(anyOf(), {})).toBe(false);
	});

	it("describes every registered row without throwing", () => {
		// The exhaustiveness check has a runtime half: a row carrying a hand-written condition literal
		// the switch does not handle would throw here rather than in a session.
		for (const statement of PROMPT_STATEMENTS) {
			const described = describeCondition(statement.condition);
			expect(described.length, `${statement.id} describes as ""`).toBeGreaterThan(0);
			expect(described, `${statement.id} describes as JSON`).not.toContain("{");
		}
	});
});

/**
 * THE BANNER HAS ONE OWNER, and `sectionBanner` is it.
 *
 * Split out of `assembleSection` because `prompt-inspect` prices statements by assembling a section one
 * row at a time and has to start from the same prefix the real assembly starts from. A second copy of
 * the `registered?.name ? renderBanner(...)` expression would make the width, the trailing newline and
 * the no-name case three places the two could disagree, which is the asymmetry the registry's banner
 * note describes ending.
 */
describe("the section banner", () => {
	it("gives every named section the banner assembly starts with", () => {
		for (const section of STATEMENT_SECTIONS) {
			const registered = SYSTEM_PROMPT_SECTIONS.find(entry => entry.id === section);
			if (!registered?.name) continue;
			const banner = sectionBanner(section);

			expect(banner, `${section} has no banner`).toContain(registered.name);
			expect(banner.endsWith("\n"), `${section}'s banner does not end the line`).toBe(true);
			expect(assembleSection(section, {}).startsWith(banner), `${section} does not open with its banner`).toBe(true);
		}
	});

	it("gives nothing to the section that has no name, which is why it is the preamble", () => {
		expect(sectionBanner("conventions")).toBe("");
		expect(assembleSection("conventions", {}).startsWith("=")).toBe(false);
	});

	it("gives nothing for a section the registry does not know", () => {
		expect(sectionBanner("no-such-section")).toBe("");
	});
});
