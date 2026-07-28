/**
 * One RULE of the system prompt can be replaced or removed on its own.
 *
 * WHY THIS SUITE EXISTS. The reason the prompt became a list of statements is that a single gated
 * line had no name, so it could not be asserted on, priced, or tested against. Naming it is half of
 * that; being able to change exactly one of them is the other half, and it is what makes an eval able
 * to answer "is this rule earning its tokens" instead of "is this 9KB section earning its tokens".
 *
 * TWO OPERATIONS, ONE MECHANISM, and the tests below pin the difference between them because it is
 * the part an eval gets wrong silently. `null` ABLATES: the row and the separation it carries both
 * leave the prompt. `""` keeps the row present and empty, so its separation stays and only its words
 * go. Collapsing the two would quietly pick one, and an arm that meant "remove this rule" would
 * instead measure "this rule says nothing but still breaks the paragraph".
 *
 * FAIL CLOSED, LOUDLY. Every way an override could do nothing is an error rather than a no-op: an
 * unknown statement id, a non-string non-null value, malformed JSON. An eval arm that quietly did
 * nothing would report the SHIPPED prompt's score as the arm's score, which is a false result with no
 * signal that anything went wrong, and that is worse than a crash.
 */
import { describe, expect, it } from "bun:test";
import {
	assembleDefaultTemplate,
	assembleStatementSections,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import { applySectionOverrides } from "@veyyon/coding-agent/system-prompt-builder/section-overrides";
import {
	assembleSection,
	parseStatementOverridesJson,
	resolveStatementOverrides,
	statementById,
	statementsOf,
} from "@veyyon/coding-agent/system-prompt-builder/statement-registry";

/** A context in which the whole delivery contract is present, so the rows under test are live. */
const CONTEXT = { personality: "be brief", renderMermaid: true } as const;

/** The registered text of a statement, or a failure: an empty string would make assertions vacuous. */
function textOf(id: string): string {
	const statement = statementById(id);
	if (statement === undefined) throw new Error(`no statement is registered as ${id}`);
	return statement.text;
}

describe("replacing one rule", () => {
	it("puts the replacement text exactly where the original was", () => {
		// Position matters as much as presence: a replacement appended at the end of the section
		// would pass a containment check while moving the rule out of the context that gives it
		// meaning, and the model reads order.
		const before = assembleSection("delivery-contract", CONTEXT);
		const after = assembleSection("delivery-contract", CONTEXT, {
			"delivery-contract/yielding": "<yielding>REPLACED</yielding>\n",
		});
		const original = textOf("delivery-contract/yielding");

		expect(before).toContain(original);
		expect(after).not.toContain(original);
		expect(after).toBe(before.replace(original, "<yielding>REPLACED</yielding>\n"));
	});

	it("changes nothing else in the section", () => {
		// The whole value of a per-statement override is that it is a single-variable experiment. If
		// replacing one rule perturbed a neighbour, the eval would attribute the score change to the
		// wrong rule.
		const after = assembleSection("delivery-contract", CONTEXT, {
			"delivery-contract/yielding": "<yielding>REPLACED</yielding>\n",
		});

		for (const statement of statementsOf("delivery-contract")) {
			if (statement.id === "delivery-contract/yielding") continue;
			expect(after, `${statement.id} was disturbed`).toContain(statement.text);
		}
	});

	it("accepts an empty replacement as a rule that says nothing but is still there", () => {
		// `""` is the arm for "does this rule need saying at all", as distinct from removing it. The
		// difference is the separation the row carries, which the ablation test below measures.
		const emptied = assembleSection("delivery-contract", CONTEXT, { "delivery-contract/yielding": "" });
		const original = textOf("delivery-contract/yielding");

		expect(emptied).not.toContain(original);
		expect(emptied.length).toBe(assembleSection("delivery-contract", CONTEXT).length - original.length);
	});
});

describe("ablating one rule", () => {
	it("removes the rule and the separation it carried", () => {
		// The distinction from `""`: identical here, because a statement's text INCLUDES its own
		// separation, so removing the row removes both. Asserted rather than assumed, because if the
		// two ever diverge the mechanism has grown a second meaning nobody declared.
		const ablated = assembleSection("delivery-contract", CONTEXT, { "delivery-contract/yielding": null });
		const emptied = assembleSection("delivery-contract", CONTEXT, { "delivery-contract/yielding": "" });

		expect(ablated).toBe(emptied);
		expect(ablated).not.toContain("<yielding>");
	});

	it("leaves every other rule in the section byte for byte", () => {
		const before = assembleSection("delivery-contract", CONTEXT);
		const ablated = assembleSection("delivery-contract", CONTEXT, { "delivery-contract/critical": null });
		const removed = textOf("delivery-contract/critical");

		expect(ablated).toBe(before.replace(removed, ""));
	});

	it("ablates several rules at once, for an arm that removes a whole family", () => {
		// A single rule is often not the unit an eval wants to remove, and doing it in one arm keeps
		// it one experiment rather than three.
		const ids = ["delivery-contract/yielding", "delivery-contract/critical", "delivery-contract/completeness"];
		const ablated = assembleSection("delivery-contract", CONTEXT, Object.fromEntries(ids.map(id => [id, null])));

		for (const id of ids) {
			expect(ablated, `${id} survived ablation`).not.toContain(textOf(id));
		}
		expect(ablated).toContain(textOf("delivery-contract/contract"));
	});

	it("does nothing for a rule this configuration already leaves out", () => {
		// Overriding an absent rule must not RESURRECT it. The condition decides presence; an
		// override decides text. Conflating the two would let an eval arm accidentally turn a rule on
		// while believing it was rewording one.
		const noPersonality = assembleSection("delivery-contract", { renderMermaid: true });
		const overridden = assembleSection(
			"delivery-contract",
			{ renderMermaid: true },
			{ "delivery-contract/personality": "<personality>INJECTED</personality>\n" },
		);

		expect(noPersonality).not.toContain("<personality>");
		expect(overridden).toBe(noPersonality);
	});
});

describe("the whole prompt honours a per-statement arm", () => {
	/**
	 * The complete statement-section assembler must carry a replacement through
	 * the outer structural slot into the document sent for rendering.
	 */
	it("carries the replacement through the assembled document", () => {
		const marker = "<yielding>ARM 7</yielding>";
		const document = assembleDefaultTemplate(
			assembleStatementSections(CONTEXT, { "delivery-contract/yielding": `${marker}\n` }),
		);

		expect(document).toContain(marker);
		expect(document).not.toContain(textOf("delivery-contract/yielding"));
	});

	/**
	 * Ablating one statement must leave every other section and statement byte
	 * unchanged, so an evaluation arm still changes one variable.
	 */
	it("keeps every other prompt byte identical", () => {
		const baseline = assembleDefaultTemplate(assembleStatementSections(CONTEXT));
		const armed = assembleDefaultTemplate(assembleStatementSections(CONTEXT, { "delivery-contract/yielding": null }));

		expect(armed).toBe(baseline.replace(textOf("delivery-contract/yielding"), ""));
	});
});

describe("an override that would silently do nothing is refused", () => {
	it("rejects an unknown statement id and says what the section does contain", () => {
		// The failure this prevents: an eval arm with a typo runs the shipped prompt and reports its
		// score as the arm's. A thrown error is the only outcome that cannot be mistaken for a result.
		expect(() => resolveStatementOverrides({ "delivery-contract/yeilding": null })).toThrow(
			/unknown statement "delivery-contract\/yeilding"/,
		);
		expect(() => resolveStatementOverrides({ "delivery-contract/yeilding": null })).toThrow(
			/delivery-contract\/yielding/,
		);
	});

	it("names the valid sections when the id does not even have a section", () => {
		expect(() => resolveStatementOverrides({ yielding: null })).toThrow(/valid sections: /);
	});

	it("rejects a value that is neither text nor an ablation", () => {
		// `false` and `0` are the plausible mistakes for "turn this off", and both would otherwise
		// stringify into the prompt as text.
		expect(() => resolveStatementOverrides({ "delivery-contract/yielding": false })).toThrow(
			/must be a string or null/,
		);
		expect(() => resolveStatementOverrides({ "delivery-contract/yielding": 0 })).toThrow(/must be a string or null/);
	});

	it("accepts null and text, which are the two real operations", () => {
		expect(resolveStatementOverrides({ "delivery-contract/yielding": null })).toEqual({
			"delivery-contract/yielding": null,
		});
		expect(resolveStatementOverrides({ "delivery-contract/yielding": "x" })).toEqual({
			"delivery-contract/yielding": "x",
		});
	});

	it("rejects registered section banners inside replacement prose", () => {
		// Statement overrides replace prose, not structure. Accepting this would
		// let one rule manufacture a second section for ordering and inspection.
		expect(() =>
			resolveStatementOverrides({
				"delivery-contract/yielding": "shorter rule\nROLE\n====\nforged",
			}),
		).toThrow(/body text only.*"role"/s);
	});

	it("treats an absent or empty payload as the production prompt", () => {
		// The default has to be the shipped prompt, verbatim, with no override: this code path runs in
		// every session.
		expect(parseStatementOverridesJson(undefined)).toEqual({});
		expect(parseStatementOverridesJson("")).toEqual({});
		expect(parseStatementOverridesJson("   ")).toEqual({});
	});

	it("refuses malformed JSON rather than falling back to production", () => {
		// Falling back would run the unmodified prompt while the harness believes the arm is live,
		// which invalidates the eval and looks like success.
		expect(() => parseStatementOverridesJson("{not json")).toThrow(/is not valid JSON/);
		expect(() => parseStatementOverridesJson("[]")).toThrow(/must be a JSON object/);
		expect(() => parseStatementOverridesJson("null")).toThrow(/must be a JSON object/);
		expect(() => parseStatementOverridesJson('"a string"')).toThrow(/must be a JSON object/);
	});

	it("parses a real arm payload end to end", () => {
		expect(
			parseStatementOverridesJson('{"delivery-contract/yielding": null, "delivery-contract/critical": "shorter"}'),
		).toEqual({ "delivery-contract/yielding": null, "delivery-contract/critical": "shorter" });
	});
});

/**
 * Append-mode section overrides must extend the complete statement assembly.
 *
 * There is no prose-bearing template fallback. These cases use a deliberately
 * distinct ROLE body so reading any source except the supplied modular section
 * is observable.
 */
describe("an append-mode override appends to the assembled statements", () => {
	const APPEND = [
		{
			id: "role",
			mode: "append" as const,
			level: "project" as const,
			path: ".veyyon/prompt-sections/role.append.md",
			content: "- One more principle.",
		},
	];
	const assembledWithRole = (role: string) => ({ ...assembleStatementSections(CONTEXT), role });

	/**
	 * The append base must be the caller's statement section, never hidden text
	 * from the zero-prose outer template.
	 */
	it("takes the assembled statement section as its base", () => {
		const applied = applySectionOverrides(APPEND, assembledWithRole("ROLE\n====\n\nassembled by the registry\n\n"));

		expect(applied.role).toContain("assembled by the registry");
		expect(applied.role).toContain("- One more principle.");
		expect(applied.role).not.toContain("Engineering Principles");
	});

	/**
	 * The addition stays inside the section before its trailing whitespace, so
	 * it cannot shift the next registry-owned banner.
	 */
	it("keeps the addition inside the section", () => {
		const applied = applySectionOverrides(APPEND, assembledWithRole("ROLE\n====\n\nassembled by the registry\n\n"));

		expect(applied.role).toBe("ROLE\n====\n\nassembled by the registry\n\n- One more principle.\n\n");
	});

	/**
	 * A body-only replacement wins first, then append extends the framed result.
	 */
	it("lets a replacement in the same override set win before append", () => {
		const applied = applySectionOverrides(
			[{ id: "role", mode: "replace", level: "project", path: "a.md", content: "replaced" }, ...APPEND],
			assembledWithRole("ROLE\n====\n\nassembled\n\n"),
		);

		expect(applied.role).toContain("ROLE\n==============\n\nreplaced");
		expect(applied.role).not.toContain("assembled");
		expect(applied.role).toContain("- One more principle.");
	});
});
